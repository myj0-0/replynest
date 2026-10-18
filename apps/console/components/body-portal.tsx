"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Escape transformed/backdrop-filtered ancestors and their fixed containing blocks.
export function BodyPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(<div className="studio-workbench-portal contents">{children}</div>, document.body) : null;
}
