import type {DatabaseComponent} from './database-runtime.js';

// Owner migration only. Existing text rows and the business receipt stay intact.
export const quickReplyImagesSchema=`
CREATE TABLE public.tenant_quick_reply_images (
 asset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES public.tenants(tenant_id),
 file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 180),
 mime_type TEXT NOT NULL CHECK(mime_type IN('image/jpeg','image/png','image/gif')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),storage_key TEXT,
 status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN('ready','deleted')),
 created_by UUID REFERENCES public.platform_users(platform_user_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),orphaned_at TIMESTAMPTZ DEFAULT NOW(),
 UNIQUE(tenant_id,asset_id),CHECK(status<>'ready' OR storage_key IS NOT NULL)
);
CREATE UNIQUE INDEX quick_reply_image_digest ON public.tenant_quick_reply_images(tenant_id,sha256) WHERE status='ready';
CREATE INDEX quick_reply_image_orphans ON public.tenant_quick_reply_images(orphaned_at,asset_id) WHERE orphaned_at IS NOT NULL;
ALTER TABLE public.tenant_quick_replies ADD COLUMN image_asset_id UUID;
ALTER TABLE public.tenant_quick_replies ADD CONSTRAINT quick_reply_image_tenant_fk
 FOREIGN KEY(tenant_id,image_asset_id) REFERENCES public.tenant_quick_reply_images(tenant_id,asset_id);
ALTER TABLE public.tenant_quick_replies DROP CONSTRAINT tenant_quick_replies_content_check;
ALTER TABLE public.tenant_quick_replies ADD CONSTRAINT quick_reply_content_v2
 CHECK(char_length(content) BETWEEN 0 AND 4000 AND (char_length(content)>0 OR image_asset_id IS NOT NULL));
CREATE INDEX quick_reply_active_image ON public.tenant_quick_replies(tenant_id,image_asset_id) WHERE status='active' AND image_asset_id IS NOT NULL;
`;
export function quickReplyImagesComponent():DatabaseComponent{return {name:'quick_reply_images',sql:quickReplyImagesSchema,migrate:async()=>{throw Error('quick_reply_images_owner_migration_required');}};}
