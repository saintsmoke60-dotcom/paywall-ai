export const metadata = {
  title: 'Paywall AI App',
  description: 'Pay-Per-Prompt Anonymous AI Marketplace',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
