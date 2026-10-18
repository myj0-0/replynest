import { pool } from "./database.js";

export type BusinessOrder = {
  external_order_id: string;
  customer_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  product_summary: string;
  product_batch_id: string | null;
  placed_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
  source_system: string;
};

export interface ReadonlyOrderProvider {
  getOrder(tenantId: string, customerId: string, orderId: string, timeoutMs: number): Promise<BusinessOrder | undefined>;
}

class PostgresMockOrderProvider implements ReadonlyOrderProvider {
  async getOrder(tenantId: string, customerId: string, orderId: string, timeoutMs: number) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SELECT set_config('statement_timeout',$1,true)`, [`${timeoutMs}ms`]);
      const result = await client.query<BusinessOrder>(
        `SELECT external_order_id,customer_id,status,amount_cents,currency,product_summary,product_batch_id,
                placed_at,paid_at,fulfilled_at,source_system
           FROM mock_orders
          WHERE tenant_id=$1 AND customer_id=$2 AND external_order_id=$3`,
        [tenantId, customerId, orderId]
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

// Production can replace this with an HTTP Order API adapter without changing Tool Gateway orchestration.
export const orderProvider: ReadonlyOrderProvider = new PostgresMockOrderProvider();
