# frozen_string_literal: true
# Owner-installed only. Startup/HTTP never creates tables or seeds legacy reads.
class AddReplynestWorkbenchReadReceipts < ActiveRecord::Migration[7.0]
  def up
    execute <<~SQL
      CREATE TABLE public.replynest_workbench_read_receipts (
        account_id BIGINT NOT NULL CHECK(account_id>0),conversation_id BIGINT NOT NULL CHECK(conversation_id>0),
        message_id BIGINT NOT NULL CHECK(message_id>0),source TEXT NOT NULL CHECK(source IN('legacy','visible')),
        read_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,conversation_id,message_id)
      );
      CREATE TABLE public.replynest_workbench_read_setup (
        id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL CHECK(state IN('pending','seeding','ready')),
        boundary BIGINT NOT NULL CHECK(boundary>=0),cursor BIGINT NOT NULL DEFAULT 0 CHECK(cursor>=0 AND cursor<=boundary),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),completed_at TIMESTAMPTZ,
        CHECK(state!='ready' OR (cursor=boundary AND completed_at IS NOT NULL))
      );
      INSERT INTO public.replynest_workbench_read_setup(id,state,boundary)
        SELECT 1,'pending',COALESCE(max(id),0) FROM public.conversations;
      CREATE INDEX rn_workbench_incoming ON public.messages(account_id,conversation_id,id)
        WHERE private=false AND message_type=0 AND sender_type='Contact';
      REVOKE ALL ON public.replynest_workbench_read_receipts,public.replynest_workbench_read_setup FROM PUBLIC;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='chatwoot_runtime') THEN
        REVOKE ALL ON public.replynest_workbench_read_receipts,public.replynest_workbench_read_setup FROM chatwoot_runtime;
        GRANT SELECT,INSERT ON public.replynest_workbench_read_receipts TO chatwoot_runtime;
        GRANT SELECT ON public.replynest_workbench_read_setup TO chatwoot_runtime;
      END IF; END $$;
    SQL
  end
  def down
    raise ActiveRecord::IrreversibleMigration, 'Read evidence must not be erased by rollback; disable the feature instead'
  end
  # Explicit resumable OWNER phase while execution is off. Only committed old
  # reads are snapshotted; late commits with older IDs/timestamps remain unread.
  def self.seed_batch(limit: 100)
    raise 'workbench execution must stay closed' unless ENV.fetch('REPLYNEST_WORKBENCH_READ_ENABLED','false')=='false'
    raise 'invalid seed batch' unless limit.is_a?(Integer) && limit.between?(1,100)
    db=ActiveRecord::Base.connection
    owner=db.select_value("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.replynest_workbench_read_setup'::regclass")
    raise 'workbench owner required' unless owner==db.select_value('SELECT current_user')
    result=nil
    db.transaction do
      db.execute("SET LOCAL statement_timeout='30s';SET LOCAL lock_timeout='3s'")
      s=db.select_one('SELECT * FROM public.replynest_workbench_read_setup WHERE id=1 FOR UPDATE')
      raise 'workbench setup missing' unless s
      if s['state']=='ready'
        result={ready:true,processed:0}
      else
        ids=db.select_values("SELECT id FROM public.conversations WHERE id>#{Integer(s['cursor'])} AND id<=#{Integer(s['boundary'])} ORDER BY id LIMIT #{limit}")
        ids.each do |id|
          c=db.select_one("SELECT id,account_id,inbox_id,contact_id,agent_last_seen_at FROM public.conversations WHERE id=#{Integer(id)} FOR SHARE")
          next unless c && c['agent_last_seen_at']
          db.execute(<<~SQL)
            INSERT INTO public.replynest_workbench_read_receipts(account_id,conversation_id,message_id,source)
             SELECT m.account_id,m.conversation_id,m.id,'legacy' FROM public.messages m
             WHERE m.account_id=#{Integer(c['account_id'])} AND m.conversation_id=#{Integer(id)} AND m.inbox_id=#{Integer(c['inbox_id'])}
              AND m.sender_type='Contact' AND m.sender_id=#{Integer(c['contact_id'])} AND m.message_type=0 AND m.private=false
              AND m.created_at<=#{db.quote(c['agent_last_seen_at'])}
             ON CONFLICT DO NOTHING
          SQL
        end
        done=ids.empty? || ids.last.to_i==s['boundary'].to_i
        cursor=done ? Integer(s['boundary']) : Integer(ids.last)
        db.execute("UPDATE public.replynest_workbench_read_setup SET state='#{done ? 'ready' : 'seeding'}',cursor=#{cursor},completed_at=#{done ? 'clock_timestamp()' : 'NULL'} WHERE id=1")
        result={ready:done,processed:ids.length}
      end
    end
    result
  end
end
