// A launcher restart reuses the existing deployment and its workflow history.
const uri = new URL(process.argv[2]).href;
const endpoint = 'http://127.0.0.1:9070/deployments';
const signal = AbortSignal.timeout(3500);

try {
  const existing = await fetch(endpoint, { signal });
  if (!existing.ok) throw new Error('Could not list Restate deployments.');
  const { deployments } = await existing.json();
  const registered = deployments.some((deployment) =>
    deployment.uri === uri && deployment.services.some((service) => service.name === 'ApprovalWorkflow'));
  if (!registered) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri }), signal,
    });
    if (!response.ok) throw new Error(await response.text());
  } else {
    // The registration may outlive the Java process. Check that the endpoint is back.
    const port = process.env.RESTATE_SERVICE_PORT || '9080';
    await fetch('http://127.0.0.1:' + port + '/discover', { signal });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
