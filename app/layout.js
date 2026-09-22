import "./globals.css";

export const metadata = {
  title: "Ivaan",
  description: "A space to practice conversational engagement with generative AI.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
