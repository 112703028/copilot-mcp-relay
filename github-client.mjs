export function createGitHubClient({ token, baseUrl = "https://api.github.com", fetchImpl = fetch }) {
  async function request(path, options = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
    }
    return response.status === 204 ? undefined : response.json();
  }
  return { request };
}
