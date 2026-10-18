import { pool } from "./database.js";
import {adminRecordList} from './admin-record-lists.js';
import type { PoolClient } from "pg";
import { platformApprovalMode, type PlatformApprovalMode } from "./approval-mode.js";

export async function runPaymentReconciliation(scopeDate = new Date().toISOString().slice(0,10)) {
  const run = await pool.query<{run_id:string}>(`INSERT INTO payment_reconciliation_runs(scope_date) VALUES($1) RETURNING run_id`,[scopeDate]);
  const runId=run.rows[0].run_id;
  await pool.query(`INSERT INTO payment_reconciliation_differences(run_id,tenant_id,payment_order_id,payment_event_id,difference_type,expected_data,actual_data)
    SELECT $1,e.tenant_id,e.payment_order_id,e.payment_event_id,
      CASE WHEN o.outbox_id IS NULL THEN 'outbox_missing' WHEN o.status='dead' THEN 'outbox_dead' ELSE 'outbox_stale' END,
      jsonb_build_object('operation',CASE e.event_type WHEN 'payment_succeeded' THEN 'settle' WHEN 'payment_refunded' THEN 'refund' ELSE 'chargeback' END,'amount_minor',e.amount_minor),
      COALESCE(jsonb_build_object('status',o.status,'attempt_count',o.attempt_count),'{}'::jsonb)
    FROM payment_events e JOIN payment_order_status_events s ON s.payment_event_id=e.payment_event_id AND s.outcome='applied'
    LEFT JOIN payment_ledger_outbox o ON o.payment_event_id=e.payment_event_id
    WHERE e.event_type IN ('payment_succeeded','payment_refunded','payment_chargeback')
      AND (o.outbox_id IS NULL OR o.status='dead' OR (o.status IN ('pending','processing') AND o.created_at<NOW()-INTERVAL '10 minutes'))`,[runId]);
  await pool.query(`INSERT INTO payment_reconciliation_differences(run_id,tenant_id,payment_order_id,payment_event_id,difference_type,expected_data,actual_data)
    SELECT $1,o.tenant_id,o.payment_order_id,o.payment_event_id,
      CASE WHEN t.transaction_id IS NULL OR t.status<>'posted' THEN 'ledger_missing' ELSE 'ledger_amount_mismatch' END,
      jsonb_build_object('amount_minor',o.amount_minor,'currency',o.currency),
      jsonb_build_object('ledger_transaction_id',o.ledger_transaction_id,'posted_amount_minor',COALESCE(x.amount_minor,0))
    FROM payment_ledger_outbox o LEFT JOIN ledger_transactions t ON t.transaction_id=o.ledger_transaction_id
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(e.amount_minor) FILTER(WHERE e.account=CASE WHEN EXISTS(SELECT 1 FROM plan_payment_purchases pp WHERE pp.payment_order_id=o.payment_order_id) THEN 'revenue' ELSE 'cash' END),0) AS amount_minor FROM ledger_entries e WHERE e.transaction_id=t.transaction_id) x ON TRUE
    WHERE o.status='succeeded' AND (t.transaction_id IS NULL OR t.status<>'posted' OR x.amount_minor<>o.amount_minor)`,[runId]);
  await pool.query(`INSERT INTO payment_reconciliation_differences(run_id,tenant_id,payment_order_id,payment_event_id,difference_type,expected_data,actual_data)
    SELECT $1,o.tenant_id,o.payment_order_id,NULL,'order_amount_mismatch',jsonb_build_object('event_refunded_minor',COALESCE(e.refunded,0)),jsonb_build_object('order_refunded_minor',o.refunded_minor)
    FROM payment_orders o LEFT JOIN LATERAL (SELECT SUM(amount_minor) FILTER(WHERE event_type IN ('payment_refunded','payment_chargeback')) AS refunded FROM payment_events WHERE payment_order_id=o.payment_order_id) e ON TRUE
    WHERE o.refunded_minor<>COALESCE(e.refunded,0)`,[runId]);
  const count=await pool.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM payment_reconciliation_differences WHERE run_id=$1 AND status='open'`,[runId]);
  await pool.query(`UPDATE payment_reconciliation_runs SET status='completed',difference_count=$2,completed_at=NOW() WHERE run_id=$1`,[runId,count.rows[0].count]);
  return {run_id:runId,scope_date:scopeDate,difference_count:count.rows[0].count};
}

export async function reconciliationOverview(params=new URLSearchParams()){
  const view=params.get('view')??'differences';if(!['differences','repairs'].includes(view))throw Error('invalid_search');
  const records=await adminRecordList(view as 'differences'|'repairs',params);
  const run=await pool.query(`SELECT run_id,scope_date,status,difference_count,started_at,completed_at,error_code FROM payment_reconciliation_runs ORDER BY scope_date DESC LIMIT 30`);
  return {runs:run.rows,differences:view==='differences'?records.items:[],repair_requests:view==='repairs'?records.items:[],page:records.page,has_more:records.has_more,view,approval_mode:platformApprovalMode()};
}

export async function requestProjectionRepair(differenceId:string,adminId:string,reason:string){
  const client=await pool.connect();try{await client.query("BEGIN");const eligible=await client.query(`SELECT difference_id FROM payment_reconciliation_differences WHERE difference_id=$1 AND status='open' AND difference_type IN ('outbox_stale','outbox_dead','ledger_missing') FOR UPDATE`,[differenceId]);if(!eligible.rows[0])throw new Error("difference_not_repairable");const mode=platformApprovalMode();const inserted=await client.query<{repair_request_id:string;approval_mode:PlatformApprovalMode}>(`INSERT INTO payment_repair_requests(difference_id,action,requested_by,request_reason,approval_mode) VALUES($1,'requeue_projection',$2,$3,$4) RETURNING repair_request_id,approval_mode`,[differenceId,adminId,reason,mode]);const result=mode==="single"?await executeProjectionRepair(client,inserted.rows[0].repair_request_id,adminId,"单管理员模式：提交后立即执行"): {...inserted.rows[0],status:"pending_approval"};await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}

async function executeProjectionRepair(client:PoolClient,repairId:string,approverId:string,reason:string){const found=await client.query<{difference_id:string;requested_by:string;payment_event_id:string;approval_mode:PlatformApprovalMode}>(`SELECT r.difference_id,r.requested_by,r.approval_mode,d.payment_event_id FROM payment_repair_requests r JOIN payment_reconciliation_differences d ON d.difference_id=r.difference_id WHERE r.repair_request_id=$1 AND r.status='pending_approval' FOR UPDATE`,[repairId]);const item=found.rows[0];if(!item)throw new Error("repair_not_pending");if(item.approval_mode==="dual"&&item.requested_by===approverId)throw new Error("separation_of_duties_required");const updated=await client.query(`UPDATE payment_ledger_outbox SET status='pending',available_at=NOW(),lease_until=NULL,last_error_code=NULL,updated_at=NOW() WHERE payment_event_id=$1 AND status IN ('pending','dead','processing','succeeded') RETURNING outbox_id`,[item.payment_event_id]);if(!updated.rows[0])throw new Error("projection_not_requeueable");await client.query(`UPDATE payment_repair_requests SET status='executed',approved_by=$2,approval_reason=$3,decided_at=NOW(),executed_at=NOW() WHERE repair_request_id=$1`,[repairId,approverId,reason]);await client.query(`UPDATE payment_reconciliation_differences SET status='repair_requested' WHERE difference_id=$1`,[item.difference_id]);return{repair_request_id:repairId,requeued:true,status:"executed",approval_mode:item.approval_mode}}

export async function approveProjectionRepair(repairId:string,approverId:string,reason:string){const client=await pool.connect();try{await client.query("BEGIN");const result=await executeProjectionRepair(client,repairId,approverId,reason);await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
