import Tinypool from 'tinypool';
Object.prototype.execArgv=['--replynest-invalid-inherited-flag'];
Object.prototype.env={NODE_OPTIONS:'--replynest-invalid-inherited-flag'};
const pool=new Tinypool({filename:new URL('./tinypool-worker.mjs',import.meta.url).href,minThreads:1,maxThreads:1,isolateWorkers:false});
try{if(await pool.run(21)!==42)throw Error('worker_result_invalid');}
finally{delete Object.prototype.execArgv;delete Object.prototype.env;await pool.destroy();}
