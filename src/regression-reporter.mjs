// Emit only runner events. Test stdout and stderr are intentionally excluded.
export default async function* report(events) {
  for await (const { type, data } of events) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    const error = data.details?.error;
    yield `shipyard-test ${JSON.stringify({
      name: data.name,
      file: data.file,
      passed: type === "test:pass",
      skipped: Boolean(data.skip || data.todo || data.details?.type === "suite"),
      failureType: error?.failureType,
      assertion: error?.cause?.code === "ERR_ASSERTION" ? error.cause.message?.split("\n", 1)[0] : undefined,
    })}\n`;
  }
}
