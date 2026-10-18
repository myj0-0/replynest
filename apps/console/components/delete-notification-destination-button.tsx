"use client";

import { LoaderCircle, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeleteNotificationDestinationButton({ id, name, en }: { id: string; name: string; en: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function remove() {
    if (!window.confirm(en ? `Permanently delete the disabled destination “${name}”?` : `永久删除已停用的通知目标“${name}”？`)) return;
    setPending(true);
    try {
      const response = await fetch(`/api/notification-destinations/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
        window.alert(body?.error?.message ?? (en ? "Could not delete the destination." : "通知目标删除失败。"));
        return;
      }
      router.refresh();
    } finally { setPending(false); }
  }

  return <button type="button" onClick={() => void remove()} disabled={pending} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
    {pending ? <LoaderCircle size={14} className="animate-spin"/> : <Trash2 size={14}/>} {en ? "Delete" : "删除"}
  </button>;
}
