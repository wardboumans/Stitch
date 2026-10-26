import type { Metadata } from "next";
import { Merriweather, Public_Sans } from "next/font/google";
import "./globals.css";

const ui = Public_Sans({ variable: "--font-ui", subsets: ["latin"] });
const serif = Merriweather({ variable: "--font-serif-body", subsets: ["latin"], weight: ["400", "700"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "Stitch",
  description: "A self-hosted RSS reader",
};

// Applies the saved theme before first paint to avoid a flash of the wrong theme.
const themeScript = `try{var t=localStorage.getItem("stitch-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${ui.variable} ${serif.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
