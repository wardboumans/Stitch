"use client";

import { useState } from "react";
import { Logo, inputClass, primaryButton } from "@/components/ui";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the auth cookie applies
    if (res.ok) window.location.assign("/");
    else {
      setError("Wrong password");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-sidebar px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-elevated p-8 shadow-pop">
        <Logo className="mb-4 h-12 w-12" />
        <h1 className="mb-1 text-xl font-semibold">Stitch</h1>
        <p className="mb-6 text-sm text-muted">Enter your password to continue.</p>
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className={inputClass} />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy} className={`${primaryButton} mt-4 w-full`}>
          Sign in
        </button>
      </form>
    </div>
  );
}
