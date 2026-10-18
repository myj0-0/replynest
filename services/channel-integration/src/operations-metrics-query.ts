/** One tenant-bound aggregate per repeated table. Counts, time boundaries and
 * eligibility remain identical; no cross-request cache of tenant statistics. */
export const OPERATIONS_COUNTS_SQL = `WITH
 customer_counts AS (
   SELECT COUNT(*) FILTER (WHERE first_seen_at >= $2) AS new_customers,
          COUNT(*) FILTER (WHERE first_seen_at < $2) AS previous_new_customers
     FROM customers WHERE tenant_id=$1 AND first_seen_at >= $4 AND first_seen_at < $3
 ),
 recommendation_counts AS (
   SELECT COUNT(*) AS ai_displayed,
          COUNT(*) FILTER (WHERE status IN ('accepted','edited')) AS ai_accepted
     FROM ai_recommendations WHERE tenant_id=$1 AND generated_at >= $5
      AND status IN ('generated','inserted','accepted','edited','rejected','expired_before_send')
 ),
 document_counts AS (
   SELECT COUNT(*) FILTER (WHERE valid_until>NOW() AND valid_until<=NOW()+INTERVAL '3 days') AS expiring_documents,
          COUNT(*) FILTER (WHERE ingestion_status='ready') AS active_knowledge_documents
     FROM knowledge_documents WHERE tenant_id=$1 AND status='active'
      AND (ingestion_status='ready' OR (valid_until>NOW() AND valid_until<=NOW()+INTERVAL '3 days'))
 ),
 event_counts AS (
   SELECT COUNT(*) FILTER (WHERE status='processed') AS processed_inbound_events,
          COUNT(*) FILTER (WHERE status IN ('queued','processing','retry_pending')) AS pending_inbound_events,
          COUNT(*) FILTER (WHERE status='dead') AS dead_inbound_events
     FROM gateway_events WHERE tenant_id=$1 AND status IN ('processed','queued','processing','retry_pending','dead')
 )
 SELECT
   (SELECT COUNT(DISTINCT ci.customer_id) FROM outbound_deliveries od
      JOIN channel_identities ci ON ci.tenant_id=od.tenant_id AND ci.chatwoot_conversation_id=od.chatwoot_conversation_id
     WHERE od.tenant_id=$1 AND od.created_at >= $2 AND od.created_at < $3) AS served_customers,
   customer_counts.*, recommendation_counts.*,
   (SELECT COUNT(*) FROM outbound_deliveries WHERE tenant_id=$1 AND status='failed') AS outbound_failures,
   (SELECT COUNT(*) FROM temporary_policies WHERE tenant_id=$1 AND status IN ('approved','active')
      AND valid_until > NOW() AND valid_until <= NOW()+INTERVAL '3 days') AS expiring_policies,
   document_counts.expiring_documents,
   (SELECT COUNT(*) FROM knowledge_jobs WHERE tenant_id=$1 AND status IN ('failed','dead')) AS failed_knowledge_jobs,
   document_counts.active_knowledge_documents,
   (SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=$1 AND status='active') AS active_members,
   event_counts.*,
   (SELECT COUNT(*) FROM channel_connections WHERE tenant_id=$1 AND status='ready' AND COALESCE(configuration->>'mode','')<>'synthetic') AS ready_channels
 FROM customer_counts CROSS JOIN recommendation_counts CROSS JOIN document_counts CROSS JOIN event_counts`;
