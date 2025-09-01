from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from ..meteora_client import MeteoraHelperClient
from ..models import AddLiquidityRequest, AddLiquidityResponse

router = APIRouter(prefix="/meteora", tags=["meteora"])
client = MeteoraHelperClient()

@router.get("/wallet")
async def wallet():
    try:
        return {"address": await client.wallet_address()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/pairs")
async def pairs(q: Optional[str] = Query(default=None, description="Filter by symbol substring")):
    try:
        return await client.list_pairs(q=q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/pool/{address}/state")
async def pool_state(address: str):
    try:
        return await client.pool_state(address)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/pool/{address}/bins")
async def pool_bins(address: str, around: int = 10):
    try:
        return await client.pool_bins(address, around=around)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/positions/{owner}")
async def positions(owner: str):
    try:
        return await client.user_positions(owner)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/pool/{address}/add-liquidity", response_model=AddLiquidityResponse)
async def add_liquidity(address: str, payload: AddLiquidityRequest):
    try:
        result = await client.add_liquidity(address, amount=payload.amount)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
