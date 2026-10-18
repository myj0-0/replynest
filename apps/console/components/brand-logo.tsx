import Image from "next/image";

export function BrandLogo({ compact = false, priority = false, className = "", href }: { compact?: boolean; priority?: boolean; className?: string; href?: string }) {
  const logo = compact
    ? <span className={`relative block size-10 shrink-0 overflow-hidden ${className}`}><Image src="/replynest-mark.png" alt="答巢 ReplyNest" fill priority={priority} sizes="40px" className="scale-125 object-contain" /></span>
    : <span className={`relative block h-10 w-[176px] shrink-0 overflow-hidden ${className}`}><Image src="/replynest-brand-cn.png" alt="答巢 ReplyNest" fill priority={priority} sizes="176px" className="object-cover" /></span>;

  return href
    ? <a href={href} aria-label="答巢 ReplyNest 首页" className="inline-block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] focus-visible:ring-offset-2">{logo}</a>
    : logo;
}
