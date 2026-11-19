import type { Metadata } from "next";
import "./globals.css";
import OfflineStatus from "@/components/OfflineStatus";
import { themeInitScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "VetCloudPro | Biñan Animal Clinic",
  description:
    "Practice management for Biñan Animal Clinic: patient records, inventory, laboratory results and service billing.",
  manifest: "/manifest.webmanifest",
  other: process.env.VETCLOUD_STATIC_EXPORT === '1' ? { 'vetcloud-static-shell': '1' } : {},
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <OfflineStatus staticShell={process.env.VETCLOUD_STATIC_EXPORT === '1'} />
        {process.env.VETCLOUD_STATIC_EXPORT === '1' && (
          <div role="note" className="bg-warning-tint px-4 py-2 text-center text-sm font-bold text-warning-text-max">
            TEST STAGING — fictional records only. {process.env.NEXT_PUBLIC_FIREBASE_STAGING_CONFIG === undefined
              ? 'Shared Firebase project' : 'Isolated Firebase project'}; not production-ready.
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
