# frozen_string_literal: true

class CreateReplynestAutomaticReplies < ActiveRecord::Migration[7.1]
  def up
    add_column :conversations, :replynest_message_revision, :bigint, null: false, default: 0
    add_index :messages, [:conversation_id, :id], order: { id: :desc },
              where: 'private = false AND message_type IN (0,1,3)', name: 'rn_automatic_recent_public'
    create_table :replynest_automatic_actors, id: false do |t|
      t.bigint :account_id, null: false, primary_key: true
      t.bigint :agent_bot_id, null: false
      t.boolean :enabled, null: false, default: false
    end
    add_foreign_key :replynest_automatic_actors, :accounts
    add_foreign_key :replynest_automatic_actors, :agent_bots
    create_table :replynest_automatic_receipts, id: :uuid do |t|
      t.bigint :account_id, null: false
      t.bigint :source_message_id, null: false
      t.string :request_digest, null: false
      t.jsonb :result, null: false
      t.timestamps
    end
    add_foreign_key :replynest_automatic_receipts, :accounts
    add_index :replynest_automatic_receipts, [:account_id, :source_message_id], unique: true,
              where: "result->>'state' = 'accepted'", name: 'rn_automatic_source_once'
    execute <<~SQL
      -- Native API, widget, background worker and direct SQL writes share the same
      -- conversation-row fence. An application callback alone cannot protect all writers.
      CREATE FUNCTION replynest_message_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cid bigint;
      BEGIN
        IF TG_OP = 'UPDATE' AND (NEW.conversation_id,NEW.account_id,NEW.inbox_id) IS DISTINCT FROM
          (OLD.conversation_id,OLD.account_id,OLD.inbox_id) THEN
          RAISE EXCEPTION 'replynest_message_binding_immutable';
        END IF;
        cid := CASE WHEN TG_OP = 'DELETE' THEN OLD.conversation_id ELSE NEW.conversation_id END;
        -- UPDATE obtains a row lock and advances a transactional fence even for
        -- edits/deletes/private notes and IDs allocated before a concurrent insert.
        UPDATE conversations SET replynest_message_revision=replynest_message_revision+1 WHERE id=cid;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER replynest_message_fence BEFORE INSERT OR UPDATE OR DELETE ON messages
        FOR EACH ROW EXECUTE FUNCTION replynest_message_fence();
      CREATE FUNCTION replynest_attachment_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE mid bigint;
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
          RAISE EXCEPTION 'replynest_attachment_binding_immutable';
        END IF;
        mid := CASE WHEN TG_OP = 'DELETE' THEN OLD.message_id ELSE NEW.message_id END;
        UPDATE conversations c SET replynest_message_revision=c.replynest_message_revision+1
          FROM messages m WHERE m.id=mid AND c.id=m.conversation_id;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER replynest_attachment_fence BEFORE INSERT OR UPDATE OR DELETE ON attachments
        FOR EACH ROW EXECUTE FUNCTION replynest_attachment_fence();
      CREATE FUNCTION replynest_revision_monotone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.replynest_message_revision < OLD.replynest_message_revision THEN
          RAISE EXCEPTION 'replynest_revision_cannot_reset';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER replynest_revision_monotone BEFORE UPDATE ON conversations
        FOR EACH ROW EXECUTE FUNCTION replynest_revision_monotone();
      CREATE FUNCTION replynest_automatic_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'replynest_automatic_append_only'; END $$;
      CREATE TRIGGER replynest_automatic_append_only BEFORE UPDATE OR DELETE ON replynest_automatic_receipts
        FOR EACH ROW EXECUTE FUNCTION replynest_automatic_append_only();
      CREATE TRIGGER replynest_automatic_no_truncate BEFORE TRUNCATE ON replynest_automatic_receipts
        FOR EACH STATEMENT EXECUTE FUNCTION replynest_automatic_append_only();
      CREATE TRIGGER replynest_messages_no_truncate BEFORE TRUNCATE ON messages
        FOR EACH STATEMENT EXECUTE FUNCTION replynest_automatic_append_only();
      CREATE TRIGGER replynest_attachments_no_truncate BEFORE TRUNCATE ON attachments
        FOR EACH STATEMENT EXECUTE FUNCTION replynest_automatic_append_only();
    SQL
  end

  def down
    execute 'DROP TRIGGER replynest_messages_no_truncate ON messages'
    execute 'DROP TRIGGER replynest_attachments_no_truncate ON attachments'
    execute 'DROP TRIGGER replynest_attachment_fence ON attachments'
    execute 'DROP TRIGGER replynest_message_fence ON messages'
    execute 'DROP TRIGGER replynest_revision_monotone ON conversations'
    drop_table :replynest_automatic_receipts
    drop_table :replynest_automatic_actors
    execute 'DROP FUNCTION replynest_automatic_append_only()'
    execute 'DROP FUNCTION replynest_message_fence()'
    execute 'DROP FUNCTION replynest_attachment_fence()'
    execute 'DROP FUNCTION replynest_revision_monotone()'
    remove_index :messages, name: 'rn_automatic_recent_public'
    remove_column :conversations, :replynest_message_revision
  end
end
