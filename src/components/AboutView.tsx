interface AboutViewProps {
  onBackToCloset?: () => void;
}

const MODULES = [
  {
    index: "01",
    title: "Closet",
    description:
      "Background-removed garment archive organized by cut and wear count.",
  },
  {
    index: "02",
    title: "Studio",
    description:
      "Virtual try-on with Rule-of-Thirds 1/3 : 2/3 proportion lines.",
  },
  {
    index: "03",
    title: "Lookbook",
    description:
      "Saved pairings and layered boards for effortless rotation.",
  },
] as const;

export function AboutView(_props: AboutViewProps) {
  return (
    <main className="mx-auto max-w-[1440px] px-5 pt-8 pb-[calc(7rem+env(safe-area-inset-bottom))] sm:px-8 sm:pt-12 lg:px-10">
      <h1 className="sr-only">About Silho</h1>

      <section className="pt-8 pb-8">
        <p className="max-w-[44ch] text-[22px] leading-[1.3] font-medium tracking-[-0.025em] text-[#141415] dark:text-[#F5F5F3]">
          Silho is an outfit-first wardrobe studio built around silhouette,
          proportion, and daily rotation.
        </p>
      </section>

      <section
        aria-label="Why Silho"
        className="border-t border-[#E8E8E6] pt-6 pb-8 dark:border-[#262629]"
      >
        <h2 className="mb-3 text-[12px] font-medium text-[#8A8A86]">
          Why Silho
        </h2>
        <p className="max-w-[58ch] text-[14px] leading-[1.65] text-[#141415]/85 sm:text-[15px] dark:text-[#F5F5F3]/85">
          Good outfits come from proportion, not buying more. Most wardrobe apps
          feel like shopping feeds or spreadsheets. Silho isolates the pieces
          you already own into clean cutouts so you can test pairings on your
          own frame before getting dressed.
        </p>
      </section>

      <section
        aria-label="Studio specification"
        className="divide-y divide-[#E8E8E6] border-y border-[#E8E8E6] dark:divide-[#262629] dark:border-[#262629]"
      >
        {MODULES.map((item) => (
          <div
            key={item.index}
            className="grid grid-cols-[36px_1fr] items-baseline py-4"
          >
            <span className="text-[12px] font-medium text-[#8A8A86] tabular-nums">
              {item.index}
            </span>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
              <span className="min-w-[88px] shrink-0 text-[14px] font-medium tracking-[-0.01em] text-[#141415] dark:text-[#F5F5F3]">
                {item.title}
              </span>
              <span className="text-[14px] leading-relaxed text-[#8A8A86]">
                {item.description}
              </span>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
