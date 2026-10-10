// Build and auth configuration, read once.
//
// The console runs on a base path, and Clerk is themed to the same paper-and-ink palette as
// the document it produces. Both are decided here so a sign-in card, a redirect, and the
// console shell cannot disagree about where the application lives or how it looks.

import { shadcn } from '@clerk/themes';

/** Deployed base path, without a trailing slash. */
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || '';
export const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL || undefined;

export const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#0f5f59',
    colorForeground: '#111c1e',
    colorMutedForeground: '#5c6b6a',
    colorDanger: '#8a5210',
    colorBackground: '#fbfaf7',
    colorInput: '#ffffff',
    colorInputForeground: '#111c1e',
    colorNeutral: '#d9dedc',
    fontFamily: 'Barlow, sans-serif',
    borderRadius: '3px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbfaf7] border border-[#d9dedc] rounded-[3px] w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#111c1e]',
    headerSubtitle: 'text-[#5c6b6a]',
    socialButtonsBlockButtonText: 'text-[#111c1e]',
    formFieldLabel: 'text-[#3d4a4a]',
    footerActionLink: 'text-[#0f5f59]',
    footerActionText: 'text-[#5c6b6a]',
    dividerText: 'text-[#5c6b6a]',
    identityPreviewEditButton: 'text-[#0f5f59]',
    formFieldSuccessText: 'text-[#0f5f59]',
    alertText: 'text-[#8a5210]',
    logoBox: 'h-10',
    logoImage: 'max-h-10',
    socialButtonsBlockButton: 'border-[#d9dedc] bg-white',
    formButtonPrimary: 'bg-[#0f5f59] text-[#fbfaf7] hover:bg-[#0c4a45]',
    formFieldInput: 'border-[#d9dedc] bg-white text-[#111c1e]',
    footerAction: 'bg-transparent',
    dividerLine: 'bg-[#d9dedc]',
    alert: 'border-[#d9b98a] bg-[#fdf6ec]',
    otpCodeFieldInput: 'border-[#d9dedc] bg-white text-[#111c1e]',
    formFieldRow: 'text-[#111c1e]',
    main: 'bg-transparent',
  },
};
