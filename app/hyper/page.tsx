import type { Metadata } from "next";
import Hyper from "@/components/Hyper";

export const metadata: Metadata = { title: "HYPERMODE · Q Terminal", description: "Market makers on Hyperliquid, read with structure and ranges" };

export default function Page() {
  return <Hyper />;
}
