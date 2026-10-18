import type {DatabaseComponent} from './database-runtime.js';
import {automaticPresentationSchema} from './reception-automatic-presentation.js';
export const AUTOMATIC_PRESENTATION_COMPONENT='automatic_reception_presentation';
/** Dedicated reviewed owner install only. Startup may verify, never migrate. */
export function automaticPresentationDatabaseComponent():DatabaseComponent {
 return {name:AUTOMATIC_PRESENTATION_COMPONENT,sql:automaticPresentationSchema,migrate:async()=>{throw Error('automatic_presentation_owner_migration_required');}};
}
