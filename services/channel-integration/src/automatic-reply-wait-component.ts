import type {DatabaseComponent} from './database-runtime.js';
import {automaticReplyWaitSchema} from './automatic-reply-wait-store.js';
export function automaticReplyWaitDatabaseComponent():DatabaseComponent {
 return {name:'automatic_reply_wait',sql:automaticReplyWaitSchema,migrate:async()=>{throw Error('reply_wait_owner_migration_required');}};
}
