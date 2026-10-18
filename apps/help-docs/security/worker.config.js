import base from '../docusaurus.config.js';
// Regression-only config: exercise the upgraded Tinypool SSG API with two
// actual workers. The production site configuration is not changed.
export default {...base,future:{v4:{removeLegacyPostBuildHeadAttribute:true},faster:{ssgWorkerThreads:true}}};
