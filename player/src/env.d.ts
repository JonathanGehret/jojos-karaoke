// Presentation API (casting to a second screen). Chrome only; feature-detected at runtime.
declare class PresentationRequest {
  constructor(urls: string[]);
  start(): Promise<unknown>;
}
