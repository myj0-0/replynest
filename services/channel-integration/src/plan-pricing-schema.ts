export const planPricingSchema=`
ALTER TABLE plan_catalog_versions ADD COLUMN IF NOT EXISTS list_price_minor BIGINT CHECK(list_price_minor IS NULL OR list_price_minor>=price_minor);
CREATE TABLE IF NOT EXISTS plan_price_publications (
  publication_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id UUID NOT NULL UNIQUE REFERENCES plan_catalog_versions(plan_version_id),
  previous_version_id UUID NOT NULL REFERENCES plan_catalog_versions(plan_version_id),
  admin_id UUID NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION protect_plan_price_publication() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'pricing publication is immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS plan_price_publication_immutable ON plan_price_publications;
CREATE TRIGGER plan_price_publication_immutable BEFORE UPDATE OR DELETE ON plan_price_publications FOR EACH ROW EXECUTE FUNCTION protect_plan_price_publication();
`;
