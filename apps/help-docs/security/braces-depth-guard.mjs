// Narrow local mitigation for GHSA-vfj7-8cjw-p6xm until braces ships a fix.
// Original code: Jon Schlinkert, MIT; see braces-LICENSE.txt. This is not an
// upstream fixed version and must not be reported as a clean raw npm audit.
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const limit="if (depth > 128) throw new SyntaxError('braces nesting exceeds safe depth limit');";
const parseLimit="if (stack.length >= 128) throw new SyntaxError('braces nesting exceeds safe depth limit');";
export const bracesPatchEdits=[
 {file:'parse.js',sha:'e572166565f15fa6ad9865ae49d678218e32aabfd1b3720f6d0d43d39800d310',replacements:[
  ["if (value === CHAR_LEFT_PARENTHESES) {\n      block =",`if (value === CHAR_LEFT_PARENTHESES) {\n      ${parseLimit}\n      block =`],
  ["if (value === CHAR_LEFT_CURLY_BRACE) {\n      depth++;",`if (value === CHAR_LEFT_CURLY_BRACE) {\n      ${parseLimit}\n      depth++;`]]},
 {file:'compile.js',sha:'dc98f22eee3d511785d92a00758d5f0d48efed5f5813bdecc2de430c529b5c9f',replacements:[
  ['const walk = (node, parent = {}) => {',`const walk = (node, parent = {}, depth = 0) => {\n    ${limit}`],
  ['walk(child, node);','walk(child, node, depth + 1);']]},
 {file:'expand.js',sha:'41ccc196ebfa7b7781a634e721eb744e4e7bcb54cba427a7e3d6806a1b9e58f7',replacements:[
  ['const walk = (node, parent = {}) => {',`const walk = (node, parent = {}, depth = 0) => {\n    ${limit}`],
  ['walk(child, node);','walk(child, node, depth + 1);']]},
 {file:'stringify.js',sha:'379f22d77bfa1478341ccd49c5e4267464aabcbba03558bab332aac23fc6f23a',replacements:[
  ['const stringify = (node, parent = {}) => {',`const stringify = (node, parent = {}, depth = 0) => {\n    ${limit}`],
  ['stringify(child);','stringify(child, undefined, depth + 1);']]},
];
function replaceOnce(text,from,to){
 if(text.split(from).length!==2)throw Error('braces_security_patch_context_changed');
 return text.replace(from,to);
}
export function patchedSource(current,edit){
 let original=current;
 if(sha(original)!==edit.sha){
  for(const [before,after] of [...edit.replacements].reverse())original=replaceOnce(original,after,before);
  if(sha(original)!==edit.sha)throw Error('braces_security_original_hash_mismatch');
 }
 return edit.replacements.reduce((text,[before,after])=>replaceOnce(text,before,after),original);
}
export function verifyBracesGuard({apply=false,projectRoot=root}={}){
 const lock=JSON.parse(readFileSync(resolve(projectRoot,'package-lock.json'),'utf8'));
 const names=Object.keys(lock.packages).filter(n=>n==='node_modules/braces'||n.endsWith('/node_modules/braces'));
 if(!names.length)throw Error('braces_security_dependency_missing');
 const modules=realpathSync(resolve(projectRoot,'node_modules'))+sep,proof=[];
 for(const name of names){
  if(!name.startsWith('node_modules/')||name.split('/').some(p=>p==='..'||p==='.'))throw Error('braces_security_path_invalid');
  if(lock.packages[name].version!=='3.0.3')throw Error('braces_security_version_requires_review');
  const directory=realpathSync(resolve(projectRoot,name));
  if(!directory.startsWith(modules))throw Error('braces_security_path_escape');
  if(JSON.parse(readFileSync(resolve(directory,'package.json'),'utf8')).version!=='3.0.3')throw Error('braces_security_installed_version_mismatch');
  for(const edit of bracesPatchEdits){
   const file=realpathSync(resolve(directory,'lib',edit.file));if(!file.startsWith(directory+sep))throw Error('braces_security_path_escape');
   const current=readFileSync(file,'utf8'),patched=patchedSource(current,edit);
   if(current!==patched){if(!apply)throw Error('braces_security_patch_not_installed');writeFileSync(file,patched);}
   if(sha(readFileSync(file))!==sha(patched))throw Error('braces_security_patch_verification_failed');
   proof.push({package:name,file:edit.file,sha256:sha(patched)});
  }
 }
 return proof;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const proof=verifyBracesGuard({apply:process.argv.includes('--apply')});
 console.log(JSON.stringify({status:'braces_local_depth_guard_verified',files:proof.length,upstream_fixed:false}));
}
