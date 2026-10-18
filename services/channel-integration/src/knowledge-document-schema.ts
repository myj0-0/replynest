import type {DatabaseComponent} from './database-runtime.js';
// Additive owner-only component. Existing dates, bodies, status and business receipt stay unchanged.
export const knowledgeDocumentSchema=`
ALTER TABLE public.knowledge_documents ADD COLUMN document_kind TEXT NOT NULL DEFAULT 'long_term' CHECK(document_kind IN('long_term','temporary'));
ALTER TABLE public.knowledge_documents ADD COLUMN scope JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.knowledge_documents ADD COLUMN requires_human_approval BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.knowledge_documents ADD COLUMN document_group_id UUID;
CREATE FUNCTION public.knowledge_document_scope_valid(v JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k TEXT; a JSONB; x JSONB;
BEGIN
 IF jsonb_typeof(v)<>'object' OR octet_length(v::text)>16384 THEN RETURN FALSE; END IF;
 FOR k,a IN SELECT key,value FROM jsonb_each(v) LOOP
  IF k NOT IN('channels','sku_ids','product_batch_ids','campaign_ids','customer_segments','regions') OR jsonb_typeof(a)<>'array' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(a)>20 THEN RETURN FALSE; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(a) LOOP
   IF jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 80 THEN RETURN FALSE; END IF;
  END LOOP;
 END LOOP; RETURN TRUE;
END $$;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_document_scope_check CHECK(public.knowledge_document_scope_valid(scope));
WITH groups AS(SELECT document_id,first_value(document_id) OVER(PARTITION BY tenant_id,title ORDER BY version,created_at,document_id) root FROM public.knowledge_documents)
UPDATE public.knowledge_documents d SET document_group_id=g.root FROM groups g WHERE d.document_id=g.document_id;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_document_tenant_identity UNIQUE(tenant_id,document_id);
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_document_group_fk FOREIGN KEY(tenant_id,document_group_id) REFERENCES public.knowledge_documents(tenant_id,document_id);
CREATE INDEX knowledge_document_groups ON public.knowledge_documents(tenant_id,document_group_id,version DESC);
CREATE INDEX knowledge_document_expiry ON public.knowledge_documents(tenant_id,valid_until) WHERE status='active' AND valid_until IS NOT NULL;
`;
export function knowledgeDocumentComponent():DatabaseComponent{return {name:'knowledge_document_controls',sql:knowledgeDocumentSchema,migrate:async()=>{throw Error('knowledge_document_owner_migration_required');}};}
