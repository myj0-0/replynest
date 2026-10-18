/** Public registration identifiers; links open the corresponding official registry. */
export function RegistrationLinks() {
  const icp = process.env.NEXT_PUBLIC_ICP_NUMBER;
  const publicSecurity = process.env.NEXT_PUBLIC_PUBLIC_SECURITY_NUMBER;
  const publicSecurityCode = process.env.NEXT_PUBLIC_PUBLIC_SECURITY_CODE;
  if (!icp && !publicSecurity) return null;
  return (
    <div className="mt-3 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs leading-6 text-slate-500">
      {icp && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:underline focus-visible:outline focus-visible:outline-2">{icp}</a>}
      {publicSecurity && <a href={publicSecurityCode ? `https://beian.mps.gov.cn/#/query/webSearch?code=${encodeURIComponent(publicSecurityCode)}` : "https://beian.mps.gov.cn/"} target="_blank" rel="noopener noreferrer" className="hover:underline focus-visible:outline focus-visible:outline-2">{publicSecurity}</a>}
    </div>
  );
}
