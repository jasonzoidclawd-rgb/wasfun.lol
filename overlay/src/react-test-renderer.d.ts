// react-test-renderer is a devDependency with no bundled types and no
// @types package installed. Declare only the surface the tests use.
declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export interface ReactTestRenderer {
    unmount(): void;
  }

  export function create(element: ReactElement): ReactTestRenderer;
  export function act(callback: () => Promise<void> | void): Promise<void>;
}
