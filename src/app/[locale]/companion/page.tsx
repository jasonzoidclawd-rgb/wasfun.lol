import { permanentRedirect } from "next/navigation";

/** Companion was replaced by the Pick screen (v3). Old links land there. */
export default async function CompanionRedirect({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  permanentRedirect(locale === "en" ? "/pick" : `/${locale}/pick`);
}
