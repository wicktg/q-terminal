import type { Metadata } from "next";
import Lab from "@/components/Lab";

export const metadata: Metadata = { title: "Q Lab", description: "Test area for LTF and HTF setups" };

export default function Page() {
  return <Lab />;
}
