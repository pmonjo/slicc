// GET /api/cloud/config — public, no auth. Returns IMS app identity + relay
// URL so the dashboard can construct its sign-in popup against environment-
// specific values without rebuilding the bundle per environment.

export interface ConfigEnv {
  IMS_CLIENT_ID?: string;
  IMS_ENVIRONMENT?: string;
}

const IMS_AUTHORIZE_URLS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com/ims/authorize/v2',
  stg1: 'https://ims-na1-stg1.adobelogin.com/ims/authorize/v2',
};

const SCOPE = 'openid,profile,email,session,ab.manage';
const RELAY_URL = 'https://www.sliccy.ai/auth/callback';
const RECEIVE_PATH = '/auth/cloud-callback';

export function handleCloudConfig(_request: Request, env: ConfigEnv): Response {
  const environment = env.IMS_ENVIRONMENT || 'prod';
  const imsAuthorizeUrl = IMS_AUTHORIZE_URLS[environment] || IMS_AUTHORIZE_URLS.prod!;
  return Response.json({
    imsClientId: env.IMS_CLIENT_ID || 'darkalley',
    imsEnvironment: environment,
    imsAuthorizeUrl,
    imsScope: SCOPE,
    imsRelayUrl: RELAY_URL,
    imsReceivePath: RECEIVE_PATH,
  });
}
