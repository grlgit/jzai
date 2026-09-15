import type { Metadata } from "next";
import { Toaster } from "sonner";
import { AppDialogHost } from "@/components/AppDialog";
import "./globals.css";

export const metadata: Metadata = {
  title: "见智·企业AI",
  description: "开门见智，工作省事",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="h-full overflow-hidden" suppressHydrationWarning>
        {children}
        <Toaster position="top-right" richColors />
        <AppDialogHost />
      </body>
    </html>
  );
}
