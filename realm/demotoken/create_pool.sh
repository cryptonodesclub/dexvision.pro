#!/usr/bin/env bash
# Creates the DXV/GNOT pool on Gnoswap (Onyx testnet) and adds the first
# liquidity. Run it from Git Bash, not PowerShell: PowerShell adds a carriage
# return to the password.
#
#   bash realm/demotoken/create_pool.sh
#
# What it signs, in order, with the gnokey key below (each one is simulated by
# gnokey before it is broadcast, so a call that would fail is not sent):
#   1. gns.Approve      the pool realm may take the 100 GNS creation fee
#   2. pool.CreatePool  DXV/wugnot, 0.3 % fee, 1 DXV = 0.001 GNOT
#   3. wugnot.Deposit   wrap 20 GNOT into wugnot (Gnoswap takes no native GNOT)
#   4. wugnot.Approve   the pool realm may take those 20 wugnot
#   5. dxv.Approve      the pool realm may take 20,000 DXV
#   6. position.Mint    full-range position with 20,000 DXV + 20 wugnot
#
# Cost: 100 GNS, 20 GNOT of liquidity (withdrawable), about 10 GNOT in fees.
set -euo pipefail

KEY=dexvision-onyx
ADDR=g1zascal5l8qyq6a3nsxgh3mms8s39t74yy0fchh
CHAIN=onyx-1
RPC=https://rpc.onyx.testnets.gno.land:443
POOL_ADDR=g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v # gno.land/r/gnoswap/pool, from its Render

DXV="gno.land/r/$ADDR/dxv.DXV"       # token0: sorts before wugnot
WUGNOT=gno.land/r/gnoland/wugnot.wugnot # token1
FEE=3000                                 # 0.3 %, tick spacing 60
SQRT_PRICE_X96=2505414483750479311864138016 # sqrt(0.001) * 2^96: 0.001 wugnot per DXV
TICK_LOWER=-887220                       # full range, aligned to 60
TICK_UPPER=887220
DXV_AMOUNT=20000000000                   # 20,000 DXV (6 decimals)
GNOT_AMOUNT=20000000                     # 20 GNOT in ugnot
GNS_FEE=100000000                        # 100 GNS

export PATH="$PATH:$HOME/go/bin:/c/Users/$USERNAME/go/bin"

read -rsp "Password for $KEY: " PASS
echo

q() { gnokey query vm/qeval -data "$1" -remote "$RPC" 2>&1 | sed -n 's/^data: //p'; }

call() { # pkgpath func gas-wanted [extra flags...] -- args...
  local pkg=$1 fn=$2 gas=$3
  shift 3
  local flags=() args=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do flags+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  for a in "$@"; do args+=(-args "$a"); done
  echo
  echo "== $pkg.$fn ${*}"
  printf '%s\n' "$PASS" | gnokey maketx call -pkgpath "$pkg" -func "$fn" "${args[@]}" "${flags[@]}" \
    -gas-fee "$((gas / 100))ugnot" -gas-wanted "$gas" -max-deposit 10000000ugnot \
    -broadcast -chainid "$CHAIN" -remote "$RPC" -insecure-password-stdin "$KEY"
}

pool_path="$DXV:$WUGNOT:$FEE"
echo "Pool: $pool_path"
echo "GNS: $(q "gno.land/r/gnoswap/gns.BalanceOf(\"$ADDR\")")  DXV: $(q "gno.land/r/$ADDR/dxv.BalanceOf(\"$ADDR\")")"
gnokey query "bank/balances/$ADDR" -remote "$RPC" | sed -n 's/^data: /GNOT: /p'

if [ "$(q "gno.land/r/gnoswap/pool.ExistsPoolPath(\"$pool_path\")")" = "(true bool)" ]; then
  echo "The pool already exists: skipping steps 1-2."
else
  call gno.land/r/gnoswap/gns Approve 100000000 -- "$POOL_ADDR" "$GNS_FEE"
  call gno.land/r/gnoswap/pool CreatePool 300000000 -- "$DXV" "$WUGNOT" "$FEE" "$SQRT_PRICE_X96"
fi

call gno.land/r/gnoland/wugnot Deposit 100000000 -send "${GNOT_AMOUNT}ugnot" --
call gno.land/r/gnoland/wugnot Approve 100000000 -- "$POOL_ADDR" "$GNOT_AMOUNT"
call "gno.land/r/$ADDR/dxv" Approve 100000000 -- "$POOL_ADDR" "$DXV_AMOUNT"

deadline=$(($(date -u +%s) + 900))
call gno.land/r/gnoswap/position Mint 300000000 -- \
  "$DXV" "$WUGNOT" "$FEE" "$TICK_LOWER" "$TICK_UPPER" \
  "$DXV_AMOUNT" "$GNOT_AMOUNT" 0 0 "$deadline" "$ADDR" ""

echo
echo "Pool exists: $(q "gno.land/r/gnoswap/pool.ExistsPoolPath(\"$pool_path\")")"
echo "Liquidity:   $(q "gno.land/r/gnoswap/pool.GetLiquidity(\"$pool_path\")")"
echo "Tick:        $(q "gno.land/r/gnoswap/pool.GetSlot0Tick(\"$pool_path\")")  (expected about -69081)"
