import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Use these instead of next/link and useRouter/usePathname/redirect from next/navigation: they keep the language prefix.
// notFound, useSearchParams and useParams still come from next/navigation.
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
