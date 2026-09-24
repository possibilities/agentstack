import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "UI Experiments",
  alternates: { types: { "text/markdown": "/x.md" } },
};

export default function Page() {
  return <main className="min-h-dvh bg-background" />;
}
