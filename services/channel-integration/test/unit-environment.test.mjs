import test from 'node:test';
import assert from 'node:assert/strict';
import {unitEnvironment} from './unit-environment.mjs';
test('unit child cannot inherit operator credentials, file secrets or integration opt-ins',()=>{
 const env=unitEnvironment({PATH:'tools',TEMP:'temporary',POSTGRES_HOST:'not-loopback',POSTGRES_PASSWORD:'operator-value',
  POSTGRES_PASSWORD_FILE:'/private/key',AI_POINTS_TEST_DATABASE_URL:'not-a-fixture',CHATWOOT_API_ACCESS_TOKEN:'operator-value',
  OPENAI_API_KEY:'operator-value',NODE_OPTIONS:'--import=/operator/script',OPERATIONS_METRICS_DB_TEST:'true',PGPASSWORD:'operator-value'});
 assert.deepEqual(env,{PATH:'tools',TEMP:'temporary',POSTGRES_HOST:'127.0.0.1',POSTGRES_DATABASE:'synthetic_unit_only',POSTGRES_USERNAME:'synthetic',POSTGRES_PASSWORD:'synthetic-not-a-credential'});
});
test('constructing unit environment does not modify caller configuration',()=>{
 const source={Path:'windows-tools',POSTGRES_HOST:'operator-host'};unitEnvironment(source);
 assert.deepEqual(source,{Path:'windows-tools',POSTGRES_HOST:'operator-host'});
});
