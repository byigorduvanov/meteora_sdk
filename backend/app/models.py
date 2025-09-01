from pydantic import BaseModel, Field
from typing import Optional, Any

class AddLiquidityRequest(BaseModel):
    amount: Optional[float] = Field(
        default=None, description="TokenX amount; if omitted, Dialect API default is used"
    )

class AddLiquidityResponse(BaseModel):
    signature: str
    confirmation: Any
