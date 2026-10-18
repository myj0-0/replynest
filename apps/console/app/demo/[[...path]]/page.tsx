import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { demoPages, demoRole, PublicDemo, type DemoPath } from '../../../components/public-demo';

export const metadata: Metadata = {
  title: '免注册演示｜答巢 ReplyNest',
  description: '使用只读合成数据浏览答巢租户控制台，无需注册，不连接真实企业或调用付费服务。',
  robots: { index: false, follow: false },
};

export default async function DemoPage({ params, searchParams }: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const path = ((await params).path ?? []).join('/');
  if (!demoPages.some(page => page[0] === path)) notFound();
  return <PublicDemo path={path as DemoPath} role={demoRole((await searchParams).role)}/>;
}
