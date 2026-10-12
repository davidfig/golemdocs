import { expect, test } from "../fixtures";

test.describe("Page zoom", () => {
  test("pinching or ctrl+scrolling over the toolbars does not zoom the page, but plain scrolling still can", async ({
    app,
    page,
  }) => {
    await app.goto("?doc=welcome");
    const prevented = (ctrlKey: boolean) =>
      page.evaluate((ctrl) => {
        const target =
          document.querySelector("#toolbar, .wm-toolbar, header") ??
          document.body;
        const e = new WheelEvent("wheel", {
          deltaY: -50,
          ctrlKey: ctrl,
          cancelable: true,
          bubbles: true,
        });
        target.dispatchEvent(e);
        return e.defaultPrevented;
      }, ctrlKey);
    expect(await prevented(true)).toBe(true);
    expect(await prevented(false)).toBe(false);
  });
});
