# frozen_string_literal: true
# Run only by the migration owner. HTTP/Sidekiq roles remain non-owners.
class CreateReplynestRuntimeSequenceHelpers < ActiveRecord::Migration[7.1]
  def up
    # Fail on unknown upstream hooks; never silently replace another trigger.
    expected = {
      'accounts_after_insert_row_tr' => 'conv_dpid_seq_',
      'camp_dpid_before_insert' => 'camp_dpid_seq_'
    }
    expected.each do |name, prefix|
      row = select_one(<<~SQL)
        SELECT t.tgtype,p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='public.accounts'::regclass AND t.tgname=#{connection.quote(name)}
          AND NOT t.tgisinternal
      SQL
      raise 'unknown upstream account sequence trigger' unless row && row['tgtype'].to_i == 5 && row['prosrc'].include?(prefix)
    end
    execute <<~SQL
      CREATE FUNCTION public.replynest_create_account_sequence() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
      DECLARE prefix text;
      BEGIN
        IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'accounts'
          OR NEW.id IS NULL OR NEW.id <= 0 THEN
          RAISE EXCEPTION 'invalid account sequence trigger' USING ERRCODE='42501';
        END IF;
        CASE TG_NAME
          WHEN 'accounts_after_insert_row_tr' THEN prefix := 'conv_dpid_seq_';
          WHEN 'camp_dpid_before_insert' THEN prefix := 'camp_dpid_seq_';
          ELSE RAISE EXCEPTION 'invalid account sequence trigger' USING ERRCODE='42501';
        END CASE;
        EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', prefix || NEW.id::text);
        RETURN NEW;
      END;
      $fn$;
      REVOKE ALL ON FUNCTION public.replynest_create_account_sequence() FROM PUBLIC;

      CREATE FUNCTION public.replynest_remove_account_sequences(account_id bigint) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
      BEGIN
        IF account_id IS NULL OR account_id <= 0
          OR EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=account_id) THEN
          RAISE EXCEPTION 'account must already be deleted' USING ERRCODE='42501';
        END IF;
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I', 'camp_dpid_seq_' || account_id::text);
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I', 'conv_dpid_seq_' || account_id::text);
      END;
      $fn$;
      REVOKE ALL ON FUNCTION public.replynest_remove_account_sequences(bigint) FROM PUBLIC;

      DROP TRIGGER accounts_after_insert_row_tr ON public.accounts;
      CREATE TRIGGER accounts_after_insert_row_tr AFTER INSERT ON public.accounts
        FOR EACH ROW EXECUTE FUNCTION public.replynest_create_account_sequence();
      DROP TRIGGER camp_dpid_before_insert ON public.accounts;
      CREATE TRIGGER camp_dpid_before_insert AFTER INSERT ON public.accounts
        FOR EACH ROW EXECUTE FUNCTION public.replynest_create_account_sequence();
    SQL
  end

  def down
    raise ActiveRecord::IrreversibleMigration, 'Keep protected sequence helpers; use a role-compatible rollback image.'
  end
end
