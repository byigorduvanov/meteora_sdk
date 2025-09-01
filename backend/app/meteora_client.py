import httpx
from .config import get_settings

class MeteoraHelperClient:
    def __init__(self, base_url: str | None = None, client: httpx.AsyncClient | None = None):
        settings = get_settings()
        self.base_url = base_url or settings.NODE_HELPER_URL
        self.client = client or httpx.AsyncClient(timeout=30.0)

    async def wallet_address(self) -> str:
        r = await self.client.get(f"{self.base_url}/wallet/address")
        r.raise_for_status()
        return r.json()["address"]

    async def list_pairs(self, q: str | None = None):
        params = {"q": q} if q else None
        r = await self.client.get(f"{self.base_url}/pairs", params=params)
        r.raise_for_status()
        return r.json()

    async def pool_state(self, address: str):
        r = await self.client.get(f"{self.base_url}/pool/{address}/state")
        r.raise_for_status()
        return r.json()

    async def pool_bins(self, address: str, around: int = 10):
        r = await self.client.get(f"{self.base_url}/pool/{address}/bins", params={"around": around})
        r.raise_for_status()
        return r.json()

    async def user_positions(self, owner: str):
        r = await self.client.get(f"{self.base_url}/positions/{owner}")
        r.raise_for_status()
        return r.json()

    async def add_liquidity(self, address: str, amount: float | None = None):
        params = {"amount": amount} if amount is not None else None
        r = await self.client.post(f"{self.base_url}/pool/{address}/add-liquidity", params=params, json={})
        r.raise_for_status()
        return r.json()
