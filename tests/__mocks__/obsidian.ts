export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
};

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl must be mocked in unit tests");
}

export class Notice {
  constructor(public message: string) {}
}
