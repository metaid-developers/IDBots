import http from 'node:http';
import https from 'node:https';

/**
 * Minimal Docker Engine API client over `node:http` (both
 * `http(s)://host:port` and `http+unix:///path.sock` transports share one
 * code path — undici's global fetch cannot speak to unix sockets without a
 * custom dispatcher).
 *
 * `tenantBaseUrl()` derives how the control plane reaches a tenant's gateway:
 * production containers publish no ports (C1), so the real path is the
 * container IP at the gateway port; the host-port-mapping branch exists for
 * the local fake-docker harness.
 */

const API_VERSION = '/v1.43';

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface DockerRequestResult {
  status: number;
  body: string;
}

export interface CreateContainerOptions {
  name: string;
  image: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  exposedPorts?: string[];
  hostConfig?: Record<string, unknown>;
}

export interface ContainerCreateResult {
  Id: string;
  Warnings?: string[];
}

export interface VolumeCreateResult {
  Name: string;
}

export interface PortBinding {
  HostIp: string;
  HostPort: string;
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  Config: {
    Image: string;
    Env: string[];
    Labels: Record<string, string>;
  };
  Image: string;
  State: {
    Status: string;
    Running: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
  };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
    Ports: Record<string, PortBinding[] | null> | null;
  };
}

export interface DockerListItem {
  Id: string;
  Names: string[];
  Image: string;
  Created: number;
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

export interface DockerImageInspect {
  Id: string;
  RepoDigests?: string[];
  Config: { Labels: Record<string, string> };
}

export function dockerImageDigest(inspect: DockerImageInspect): string | null {
  const repoDigest = inspect.RepoDigests?.find((entry) => entry.includes('@sha256:'));
  const digest = repoDigest?.slice(repoDigest.indexOf('@') + 1) ?? inspect.Id;
  return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : null;
}

interface Transport {
  requestOptions(path: string): { options: http.RequestOptions; requestUrl?: URL };
}

class HttpTransport implements Transport {
  constructor(private readonly baseUrl: URL) {}

  requestOptions(path: string) {
    const requestUrl = new URL(path, this.baseUrl);
    return {
      requestUrl,
      options: {
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        protocol: requestUrl.protocol,
        headers: { Host: requestUrl.host },
      },
    };
  }
}

class UnixSocketTransport implements Transport {
  constructor(private readonly socketPath: string) {}

  requestOptions(path: string) {
    return {
      options: {
        socketPath: this.socketPath,
        path,
        headers: { Host: 'docker' },
      },
    };
  }
}

export class DockerClient {
  private readonly transport: Transport;

  constructor(url: string) {
    if (url.startsWith('http+unix://')) {
      this.transport = new UnixSocketTransport(decodeURIComponent(url.slice('http+unix://'.length)));
      return;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      this.transport = new HttpTransport(new URL(url));
      return;
    }
    throw new Error(`CP_DOCKER_URL must be http(s):// or http+unix://, got "${url}"`);
  }

  private requestBuffer(method: string, path: string, body?: string, timeoutMs = 10_000): Promise<{ status: number; body: Buffer }> {
    const { options } = this.transport.requestOptions(path);
    return new Promise((resolve, reject) => {
      const client = options.protocol === 'https:' ? https : http;
      const req = client.request(
        {
          ...options,
          method,
          headers: {
            ...options.headers,
            // The staging docker-socket-proxy rejects bodied requests whose
            // Content-Type is not application/json (400), so every bodied
            // call must declare it; empty-bodied calls (GET/DELETE/start…)
            // stay header-free.
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            'Content-Length': body ? Buffer.byteLength(body) : 0,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('docker request timed out')));
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body));
    if (result.status >= 300) {
      let detail = result.body;
      try {
        detail = (JSON.parse(result.body) as { message?: string }).message ?? result.body;
      } catch {
        // keep raw body
      }
      throw new DockerError(`${method} ${path} failed with ${result.status}: ${detail}`, result.status);
    }
    return (result.body ? JSON.parse(result.body) : {}) as T;
  }

  private request(method: string, path: string, body?: string): Promise<DockerRequestResult> {
    return this.requestBuffer(method, path, body).then((r) => ({ status: r.status, body: r.body.toString('utf8') }));
  }

  /** `GET /_ping` — true when the engine answers 200, false otherwise. */
  async ping(): Promise<boolean> {
    try {
      const result = await this.request('GET', '/_ping');
      return result.status === 200;
    } catch {
      return false;
    }
  }

  async createVolume(name: string, labels?: Record<string, string>): Promise<VolumeCreateResult> {
    return this.requestJson('POST', `${API_VERSION}/volumes/create`, {
      Name: name,
      Driver: 'local',
      Labels: labels ?? {},
    });
  }

  async removeVolume(name: string): Promise<void> {
    await this.requestJson('DELETE', `${API_VERSION}/volumes/${encodeURIComponent(name)}`);
  }

  async createContainer(opts: CreateContainerOptions): Promise<ContainerCreateResult> {
    const body: Record<string, unknown> = {
      Image: opts.image,
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Labels: opts.labels ?? {},
    };
    if (opts.exposedPorts && opts.exposedPorts.length > 0) {
      body.ExposedPorts = Object.fromEntries(opts.exposedPorts.map((p) => [p, {}]));
    }
    if (opts.hostConfig) {
      body.HostConfig = opts.hostConfig;
    }
    return this.requestJson('POST', `${API_VERSION}/containers/create?name=${encodeURIComponent(opts.name)}`, body);
  }

  /** Start a container; 304 (already running) counts as success. */
  async startContainer(id: string): Promise<void> {
    const result = await this.request('POST', `${API_VERSION}/containers/${id}/start`);
    if (result.status !== 204 && result.status !== 304) {
      throw new DockerError(`start ${id} failed with ${result.status}: ${result.body}`, result.status);
    }
  }

  /** Stop a container (SIGTERM, then SIGKILL after the grace period). */
  async stopContainer(id: string, timeoutSec = 30): Promise<void> {
    const result = await this.request('POST', `${API_VERSION}/containers/${id}/stop?t=${timeoutSec}`);
    if (result.status !== 204 && result.status !== 304) {
      throw new DockerError(`stop ${id} failed with ${result.status}: ${result.body}`, result.status);
    }
  }

  async removeContainer(id: string, opts?: { volumes?: boolean; force?: boolean }): Promise<void> {
    const params = new URLSearchParams();
    if (opts?.volumes) {
      params.set('v', '1');
    }
    if (opts?.force) {
      params.set('force', '1');
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    await this.requestJson('DELETE', `${API_VERSION}/containers/${id}${suffix}`);
  }

  async inspectContainer(id: string): Promise<DockerContainerInspect> {
    return this.requestJson('GET', `${API_VERSION}/containers/${id}/json`);
  }

  async listContainers(opts?: { namePrefix?: string; all?: boolean }): Promise<DockerListItem[]> {
    const params = new URLSearchParams();
    params.set('all', opts?.all === false ? '0' : '1');
    if (opts?.namePrefix) {
      params.set('filters', JSON.stringify({ name: [opts.namePrefix] }));
    }
    return this.requestJson('GET', `${API_VERSION}/containers/json?${params.toString()}`);
  }

  async imageInspect(ref: string): Promise<DockerImageInspect> {
    return this.requestJson('GET', `${API_VERSION}/images/${encodeURIComponent(ref)}/json`);
  }

  async pullImage(ref: string, timeoutMs = 30 * 60_000): Promise<void> {
    const params = new URLSearchParams({ fromImage: ref });
    const result = await this.requestBuffer('POST', `${API_VERSION}/images/create?${params.toString()}`, undefined, timeoutMs);
    if (result.status >= 300) {
      throw new DockerError(`pull ${ref} failed with ${result.status}: ${result.body.toString('utf8').slice(0, 1000)}`, result.status);
    }
  }

  async containerLogs(id: string, sinceSec?: number): Promise<string> {
    const params = new URLSearchParams({ stdout: '1', stderr: '1' });
    if (sinceSec !== undefined) {
      params.set('since', String(sinceSec));
    }
    const result = await this.request('GET', `${API_VERSION}/containers/${id}/logs?${params.toString()}`);
    if (result.status !== 200) {
      throw new DockerError(`logs ${id} failed with ${result.status}: ${result.body}`, result.status);
    }
    return result.body;
  }

  /** `GET /containers/{id}/archive?path=...` — a tar of the container path (tenant export). */
  async containerArchive(id: string, containerPath: string): Promise<Buffer> {
    const params = new URLSearchParams({ path: containerPath });
    const result = await this.requestBuffer('GET', `${API_VERSION}/containers/${id}/archive?${params.toString()}`);
    if (result.status !== 200) {
      throw new DockerError(`archive ${id} failed with ${result.status}`, result.status);
    }
    return result.body;
  }
}

/**
 * Where the control plane reaches a tenant's C1 gateway. Production
 * containers publish no ports (C1), so the real path is the first container
 * network IP at `defaultPort`; the host-port-mapping branch exists for the
 * local fake-docker harness, which maps container 8790 to an ephemeral
 * 127.0.0.1 port.
 */
export function tenantBaseUrl(inspect: DockerContainerInspect, defaultPort = 8790): string {
  const bindings = inspect.NetworkSettings?.Ports?.['8790/tcp'];
  if (bindings && bindings.length > 0 && bindings[0].HostPort) {
    return `http://${bindings[0].HostIp}:${bindings[0].HostPort}`;
  }
  const networks = inspect.NetworkSettings?.Networks ?? {};
  for (const net of Object.values(networks)) {
    if (net.IPAddress) {
      return `http://${net.IPAddress}:${defaultPort}`;
    }
  }
  throw new DockerError(`container ${inspect.Id} has no usable network address`, 0);
}
