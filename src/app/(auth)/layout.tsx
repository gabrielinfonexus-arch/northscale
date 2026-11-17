export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-[17px] font-semibold tracking-tight">NorthScale</div>
        {children}
      </div>
    </main>
  );
}
