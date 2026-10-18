import {pool,businessSchemaSql,migrate} from './database.js';
import {automaticReceptionSchemaSql,migrateAutomaticReception} from './automatic-reception-migrate.js';
import {sharedWechatStoreSchemaSql,migrateSharedWechatStore} from './shared-wechat-store.js';
import {sharedWechatDeliverySchemaSql,migrateSharedWechatDelivery} from './shared-wechat-delivery.js';
import {sharedWechatPortalSchemaSql,migrateSharedWechatPortal} from './shared-wechat-portal.js';
import {sharedWechatManagementSchemaSql,migrateSharedWechatManagement} from './shared-wechat-management.js';
import type {DatabaseComponent} from './database-runtime.js';
import {automaticWechatSchemaSql,migrateAutomaticWeChat} from './automatic-wechat-migrate.js';
import {automaticSemanticDatabaseComponent} from './automatic-knowledge-migrate.js';
import {receptionPersonalizationDatabaseComponent} from './reception-personalization-component.js';
import {publicAiLabelDatabaseComponent,publicAiLabelDefault} from './ai-public-label.js';
import {historyKnowledgeDatabaseComponent} from './reception-history-knowledge-component.js';
import {automaticPresentationDatabaseComponent} from './reception-automatic-presentation-component.js';
import {automaticReplyWaitDatabaseComponent} from './automatic-reply-wait-component.js';
import {externalWebhookLeaseComponent} from './external-webhook-store.js';
import {studioWorkflowComponent} from './studio-workflow-schema.js';
import {tenantSecurityComponent} from './tenant-security-schema.js';
import {wechatMediaComponent} from './wechat-media-store.js';
import {customerInsightsComponent} from './customer-insights-schema.js';
import {quickReplyImagesComponent} from './quick-reply-images-schema.js';
import {knowledgeDocumentComponent} from './knowledge-document-schema.js';
import {referralPartnerComponent} from './referral-partner-schema.js';

/** Flags select required schemas, not permission to execute customer actions. */
export function databaseComponents(env:NodeJS.ProcessEnv,service:'gateway'|'knowledge'='gateway'):DatabaseComponent[]{
 publicAiLabelDefault(env);
 const result:DatabaseComponent[]=[{name:'business',sql:businessSchemaSql(),migrate}];
 if(env.KNOWLEDGE_DOCUMENT_CONTROLS_ENABLED==='true'){
  if(env.DATABASE_STARTUP_MODE!=='verify')throw Error('knowledge_document_owner_migration_required');
  result.push(knowledgeDocumentComponent());
 }
 if(service==='knowledge')return result;
 if(env.REFERRAL_PARTNER_ACCESS_ENABLED==='true'){
  if(env.DATABASE_STARTUP_MODE!=='verify')throw Error('referral_partner_owner_migration_required');
  result.push(referralPartnerComponent());
 }
 if(env.QUICK_REPLY_IMAGES_ENABLED==='true'){
  if(env.DATABASE_STARTUP_MODE!=='verify'||env.WECHAT_MEDIA_ENABLED!=='true')throw Error('quick_reply_images_verified_media_required');
  result.push(quickReplyImagesComponent());
 }
 if(env.AI_CUSTOMER_INSIGHTS_ENABLED==='true'){
  if(env.DATABASE_STARTUP_MODE!=='verify')throw Error('customer_insights_owner_migration_required');
  result.push(customerInsightsComponent());
 }
 if(env.WECHAT_MEDIA_ENABLED==='true'){
  if(env.DATABASE_STARTUP_MODE!=='verify')throw Error('wechat_media_owner_migration_required');
  const days=Number(env.WECHAT_MEDIA_RETENTION_DAYS??180);if(!Number.isInteger(days)||days<1||days>365)throw Error('wechat_media_retention_invalid');
  result.push(wechatMediaComponent());
 }
 if(env.TENANT_SECURITY_LOGS_ENABLED==='true'){
  if(env.DATABASE_STARTUP_MODE!=='verify')throw Error('tenant_security_owner_migration_required');
  result.push(tenantSecurityComponent());
 }
 if(['STUDIO_MESSAGE_EVENTS_ENABLED','STUDIO_HTTP_ENABLED','STUDIO_CAMPAIGNS_ENABLED'].some(k=>env[k]==='true'))result.push(studioWorkflowComponent());
 if(env.OPEN_PLATFORM_ENABLED==='true')result.push(externalWebhookLeaseComponent());
 if(env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED==='true')result.push({name:'automatic_reception',sql:automaticReceptionSchemaSql(),migrate:()=>migrateAutomaticReception(pool,true)});
 const wechat=env.AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED==='true';
 if(wechat||['SHARED_WECHAT_CALLBACK_ENABLED','SHARED_WECHAT_DELIVERY_ENABLED','SHARED_WECHAT_MANAGEMENT_ENABLED'].some(key=>env[key]==='true'))result.push({name:'shared_store',sql:sharedWechatStoreSchemaSql(),migrate:()=>migrateSharedWechatStore(pool)});
 if(wechat||env.SHARED_WECHAT_DELIVERY_ENABLED==='true')result.push({name:'shared_delivery',sql:sharedWechatDeliverySchemaSql(),migrate:()=>migrateSharedWechatDelivery(pool)});
 if(env.SHARED_WECHAT_MANAGEMENT_ENABLED==='true')result.push({name:'shared_portal',sql:sharedWechatPortalSchemaSql(),migrate:()=>migrateSharedWechatPortal(pool)},{name:'shared_management',sql:sharedWechatManagementSchemaSql(),migrate:()=>migrateSharedWechatManagement(pool)});
 if(wechat)result.push({name:'automatic_wechat',sql:automaticWechatSchemaSql(),migrate:()=>migrateAutomaticWeChat(pool,true)});
 if(env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED==='true'){
  if(env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED!=='true')throw Error('semantic_management_component_required');
  result.push(automaticSemanticDatabaseComponent());
 }
 if(env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED==='true'){
  if(env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify')throw Error('personalization_verified_management_required');
  result.push(receptionPersonalizationDatabaseComponent());
 }
 if(env.AI_PUBLIC_LABEL_SETTINGS_ENABLED==='true'){
  if(env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify')throw Error('ai_public_label_verified_management_required');
  result.push(publicAiLabelDatabaseComponent());
 }
 if(env.AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED==='true'){
  if(env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify')throw Error('history_knowledge_verified_personalization_required');
  result.push(historyKnowledgeDatabaseComponent());
 }
 if(env.AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED==='true'){
  if(env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED!=='true'||env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED!=='true'||
   env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify')throw Error('automatic_presentation_verified_components_required');
  result.push(automaticPresentationDatabaseComponent());
 }
 if(env.AI_RECEPTION_REPLY_TIMING_ENABLED==='true'){
  if(env.AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify')throw Error('reply_wait_verified_presentation_required');
  result.push(automaticReplyWaitDatabaseComponent());
 }
 return result;
}
