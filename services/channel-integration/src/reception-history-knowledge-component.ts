import type {DatabaseComponent} from './database-runtime.js';
import {historyKnowledgeSchema} from './reception-history-knowledge.js';
export function historyKnowledgeDatabaseComponent():DatabaseComponent{
 return {name:'reception_history_knowledge',sql:historyKnowledgeSchema,migrate:async()=>{throw Error('history_knowledge_owner_migration_required');}};
}
