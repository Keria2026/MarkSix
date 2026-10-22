#!/usr/bin/env python3
"""Destructive only to marksix_test. Actual HTTP/MySQL/worker with an independent
Decimal oracle. No production keys, endpoints or customer databases are used.
Run after cargo build --locked --example runtime_server (from backend).
"""

import copy
import datetime as dt
import http.cookiejar
import json
import os
import random
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8082"
SEED = 20261015
ZODIACS = "鼠牛虎兔龙蛇马羊猴鸡狗猪"
RED = {1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46}
BLUE = {3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48}


def rounded(cents, rate):
    return int(
        (Decimal(cents) * Decimal(str(rate))).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )


def zodiac(n, year):
    return (6 + year - 2026 - (n - 1) % 12) % 12


def wave(n):
    return 0 if n in RED else 1 if n in BLUE else 2


def project(kind, n, z, w):
    return {
        "number": n,
        "zodiac": z,
        "tail": n % 10,
        "wave": w,
        "size": int(n >= 25),
        "parity": n % 2,
    }[kind]


def atomic_options(rule, selected, compound):
    import itertools

    selected = list(selected) if rule["condition"] == "hard_pair" else sorted(selected)
    k = rule["combination_size"] if compound else min(len(selected), rule["quantity"])
    return [list(c) for c in itertools.combinations(selected, k)]


def atom_rates(rule, opts, year):
    natal = (6 + year - 2026) % 12
    natal_opts = (
        {
            project(rule["kind"], n, zodiac(n, year), wave(n))
            for n in range(1, 50)
            if zodiac(n, year) == natal
        }
        if rule["kind"] not in ("wave", "zodiac_count")
        else set()
    )
    special = bool(set(opts) & natal_opts)
    return (
        rule["zero_tail_odds"]
        if rule["kind"] == "tail"
        and 0 in opts
        and rule.get("zero_tail_odds") is not None
        else rule.get("special_odds")
        if special and rule.get("special_odds") is not None
        else rule["odds"],
        rule.get("special_rebate_percent")
        if special and rule.get("special_rebate_percent") is not None
        else rule["rebate_percent"],
    )


def oracle(rule, opts, cents, draw, year):
    odds, rebate = atom_rates(rule, opts, year)
    scope = rule["scope"]
    indexes = (
        range(6) if scope == "regular" else [6] if scope == "special" else range(7)
    )
    voided = rule["kind"] in ("size", "parity") and any(
        draw["numbers"][i] == 49 for i in indexes
    )
    if rule["kind"] == "zodiac_count":
        won = len(set(draw["zodiac"])) == rule["zodiac_count"]
    elif rule["condition"] in ("hard_pair", "soft_pair"):
        a, b = opts
        won = draw["numbers"][6] == a and b in draw["numbers"][:6]
        if rule["condition"] == "soft_pair":
            won |= draw["numbers"][6] == b and a in draw["numbers"][:6]
    else:
        actual = {
            project(
                rule["kind"], draw["numbers"][i], draw["zodiac"][i], draw["waves"][i]
            )
            for i in indexes
        }
        hits = len(set(opts) & actual)
        won = {
            "all": hits == len(opts),
            "none": hits == 0,
            "any": hits >= 1,
            "at_least": hits >= rule["minimum_hits"],
        }[rule["condition"]]
    won = bool(won and not voided)
    if won and rule.get("special_hit_odds") is not None and draw["numbers"][6] in opts:
        odds = rule["special_hit_odds"]
    payout = cents if voided else rounded(cents, odds) if won else 0
    rebate = 0 if voided else rounded(cents, Decimal(rebate) / 100)
    return dict(
        voided=voided,
        won=won,
        payout=payout,
        rebate=rebate,
        net=cents - payout - rebate,
    )


class Acceptance:
    def __init__(self):
        self.random = random.Random(SEED)
        self.token = secrets.token_hex(24)
        self.env = dict(os.environ, FIXTURE_TOKEN=self.token)
        assert self.env.get("TEST_DATABASE_URL", "").endswith("/marksix_test"), (
            "Only disposable marksix_test allowed"
        )
        self.password = self.env["TEST_ADMIN_PASSWORD"]
        self.jar = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )
        self.checks = 0
        self.bets = 0
        self.units = 0
        self.flyouts = 0
        self.draws = 0
        self.cases = []
        self.proc = None
        self.log = None

    def equal(self, actual, expected, context):
        self.checks += 1
        if actual != expected:
            raise AssertionError(f"{context}: expected {expected!r}, got {actual!r}")

    def request(self, method, path, body=None, expected=200):
        headers = {
            "Content-Type": "application/json",
            "X-Marksix": "1",
            "X-Fixture-Token": self.token,
        }
        req = urllib.request.Request(
            BASE + path,
            data=json.dumps(body, ensure_ascii=False).encode()
            if body is not None
            else None,
            headers=headers,
            method=method,
        )
        try:
            with self.http.open(req, timeout=75) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        try:
            data = json.loads(raw)
        except ValueError:
            data = raw.decode(errors="replace")
        self.checks += 1
        if status != expected:
            raise AssertionError(
                f"{method} {path}: expected HTTP {expected}, got {status}: {data}"
            )
        return data

    def control(self, action, **kw):
        return self.request("POST", "/fixture/control", dict(action=action, **kw))

    def start(self, reset):
        self.env["RUNTIME_RESET"] = "yes" if reset else "no"
        self.proc = subprocess.Popen(
            [str(ROOT / "backend/target/debug/examples/runtime_server")],
            cwd=ROOT,
            env=self.env,
            stdout=self.log,
            stderr=subprocess.STDOUT,
        )
        for _ in range(100):
            if self.proc.poll() is not None:
                raise RuntimeError(
                    "fixture exited; inspect test-results/runtime-server.log"
                )
            try:
                with urllib.request.urlopen(BASE + "/api/health", timeout=1):
                    return
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        raise RuntimeError("fixture startup timeout")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=25)

    def payload(self, play, options, compound=False, amount="10", bettor="验收客户甲"):
        return dict(
            period=self.period,
            play_id=play["id"],
            play_version=play["version"],
            selections=options,
            compound=compound,
            amount=amount,
            bettor=bettor,
            request_id=str(uuid.uuid4()),
        )

    def add(self, play, options, compound=False, amount="10", bettor="验收客户甲"):
        payload = self.payload(play, options, compound, amount, bettor)
        response = self.request("POST", "/api/bets", payload)
        model = dict(
            id=response["id"],
            rule=copy.deepcopy(play["rule"]),
            options=atomic_options(play["rule"], options, compound),
            amount=int(Decimal(amount) * 100),
            bettor=bettor,
            cancelled=False,
            layoffs=[],
            payload=payload,
        )
        detail = self.request("GET", "/api/bets/" + model["id"])
        self.equal(len(detail["atoms"]), len(model["options"]), "split count")
        self.equal(
            detail["record"]["stake"], len(model["options"]) * model["amount"], "stake"
        )
        for atom, opts in zip(detail["atoms"], model["options"]):
            odds, rebate = atom_rates(model["rule"], opts, self.year)
            self.equal(atom["options"], opts, "atomic options")
            self.equal(atom["odds"], odds, "natal odds")
            self.equal(atom["payout"], rounded(model["amount"], odds), "rounded payout")
            self.equal(
                atom["rebate"],
                rounded(model["amount"], Decimal(rebate) / 100),
                "rounded rebate",
            )
            self.equal(
                atom.get("special_hit_payout"),
                rounded(model["amount"], model["rule"]["special_hit_odds"])
                if model["rule"].get("special_hit_odds")
                else None,
                "conditional snapshot",
            )
        self.bets += 1
        self.units += len(model["options"])
        self.models.append(model)
        return model

    def revise(self, model, amount, receiver=None, expected=200):
        detail = self.request("GET", "/api/bets/" + model["id"])
        body = dict(
            request_id=str(uuid.uuid4()),
            revision=detail["record"]["revision"],
            amount=amount,
            receiver=receiver,
        )
        path = "/api/bets/" + model["id"] + ("/layoffs" if receiver else "/amount")
        result = self.request("POST" if receiver else "PUT", path, body, expected)
        if expected == 200:
            replay = self.request("POST" if receiver else "PUT", path, body)
            self.equal(replay, result, "mutation idempotency")
            if receiver:
                detail = self.request("GET", "/api/bets/" + model["id"])
                fly = next(
                    row for row in detail["layoffs"] if row["id"] == result["id"]
                )
                model["layoffs"].append(
                    dict(
                        id=fly["id"],
                        receiver=receiver,
                        amount=int(Decimal(amount) * 100),
                    )
                )
                self.flyouts += 1
            else:
                model["amount"] = int(Decimal(amount) * 100)
        return result

    def create_play(self, name, **kw):
        rule = dict(self.plays["特码"]["rule"], name=name, **kw)
        result = self.request("POST", "/api/plays", rule)
        return next(
            p
            for p in self.request("GET", "/api/bootstrap")["plays"]
            if p["id"] == result["id"]
        )

    def raw_draw(self, date, numbers, override=False):
        year = int(date[:4])
        draw = dict(
            numbers=numbers,
            zodiac=[zodiac(n, year) for n in numbers],
            waves=[wave(n) for n in numbers],
        )
        if override:
            draw["zodiac"][0] = (draw["zodiac"][0] + 1) % 12
            draw["waves"][6] = (draw["waves"][6] + 1) % 3
        raw = dict(
            expect=self.period,
            openTime=date + " 21:32:32",
            openCode=",".join(f"{n:02}" for n in numbers),
            zodiac=",".join(ZODIACS[z] for z in draw["zodiac"]),
            wave=",".join(["red", "blue", "green"][w] for w in draw["waves"]),
        )
        return draw, raw

    def verify_settlement(self, draw):
        def empty():
            return dict(
                records=0, units=0, stake=0, rebate=0, payout=0, refunded=0, net=0
            )

        incoming, outgoing = empty(), empty()
        bettors, receivers = {}, {}

        def ledger(target, results, cents, outgoing=False):
            units = sum(not r["voided"] for r in results)
            target["records"] += int(units > 0)
            target["units"] += units
            target["stake"] += units * cents
            target["rebate"] += sum(r["rebate"] for r in results)
            target["refunded"] += (len(results) - units) * cents
            target["payout"] += sum(r["payout"] for r in results if not r["voided"])
            target["net"] += sum(r["net"] for r in results) * (-1 if outgoing else 1)

        for m in self.models:
            detail = self.request("GET", "/api/bets/" + m["id"])
            if m["cancelled"]:
                self.equal(detail["record"]["status"], "cancelled", "cancel permanent")
                if not m.get("postdraw_cancelled"):
                    self.equal(detail["results"], None, "cancel not settled")
                continue
            results = [
                oracle(m["rule"], opts, m["amount"], draw, self.year)
                for opts in m["options"]
            ]
            self.equal(
                detail["results"],
                results,
                "independent atom settlement: " + m["rule"]["name"],
            )
            for key in ["payout", "rebate"]:
                self.equal(
                    detail["record"][key], sum(r[key] for r in results), "record " + key
                )
            self.equal(
                detail["record"]["void_stake"],
                sum(r["voided"] for r in results) * m["amount"],
                "refund",
            )
            ledger(incoming, results, m["amount"])
            ledger(bettors.setdefault(m["bettor"], empty()), results, m["amount"])
            for fly in m["layoffs"]:
                row = next(
                    item for item in detail["layoffs"] if item["id"] == fly["id"]
                )
                if fly.get("cancelled"):
                    self.equal(row["status"], "cancelled", "fly cancellation")
                    continue
                fr = [
                    oracle(m["rule"], opts, fly["amount"], draw, self.year)
                    for opts in m["options"]
                ]
                for key in ["payout", "rebate"]:
                    self.equal(
                        row[key], sum(r[key] for r in fr), "outgoing rounded " + key
                    )
                self.equal(
                    row["void_stake"],
                    sum(r["voided"] for r in fr) * fly["amount"],
                    "outgoing refund",
                )
                ledger(outgoing, fr, fly["amount"], True)
                ledger(
                    receivers.setdefault(fly["receiver"], empty()),
                    fr,
                    fly["amount"],
                    True,
                )
        stats = self.request("GET", f"/api/periods/{self.period}/statistics")
        self.equal(stats["incoming"], incoming, "all incoming totals")
        self.equal(stats["outgoing"], outgoing, "all outgoing totals")
        self.equal(
            {v["name"]: v["totals"] for v in stats["bettors"]}, bettors, "bettor groups"
        )
        self.equal(
            {v["name"]: v["totals"] for v in stats["receivers"]},
            receivers,
            "receiver groups",
        )
        retained = {
            key: incoming[key] - outgoing[key] for key in ["stake", "rebate", "payout"]
        }
        retained["net"] = incoming["net"] + outgoing["net"]
        self.equal(stats["retained"], retained, "retained totals")
        p = self.request("GET", f"/api/periods/{self.period}")
        self.equal(p["totals"]["net"], incoming["net"], "period net")
        self.equal(p["totals"]["retained_net"], retained["net"], "period retained net")
        self.equal(p["draw"]["waves"], draw["waves"], "API wave labels retained")
        return stats

    def execute(self):
        started = time.monotonic()
        (ROOT / "test-results").mkdir(exist_ok=True)
        self.log = (ROOT / "test-results/runtime-server.log").open("w")
        try:
            self.start(True)
            self.request(
                "POST",
                "/api/login",
                dict(username="test-admin", password=self.password),
            )
            boot = self.request("GET", "/api/bootstrap")
            for p in boot["plays"]:
                self.request(
                    "DELETE", "/api/plays/" + str(p["id"]), dict(version=p["version"])
                )
            fixture = json.loads((ROOT / "fixtures/customer-plays.json").read_text())
            self.request("POST", "/api/plays/import", fixture)
            self.plays = {
                p["rule"]["name"]: p
                for p in self.request("GET", "/api/bootstrap")["plays"]
            }
            self.equal(
                len(self.plays), len(fixture["plays"]), "all customer plays imported"
            )
            exported = self.request("GET", "/api/plays/export")
            self.equal(exported, fixture, "portable rule roundtrip")
            # Supplementary boundary fixtures; the shared customer file stays exact.
            self.extra = [self.create_play("严格单选", selection_limit=1)]
            self.extra += [
                self.create_play(
                    "五有普通多选",
                    kind="zodiac",
                    scope="all",
                    quantity=5,
                    combination_size=5,
                    relation="ge",
                    odds="100",
                    special_odds="90",
                )
            ]
            self.extra += [
                self.create_play(
                    "五有复式",
                    kind="zodiac",
                    scope="all",
                    quantity=5,
                    combination_size=5,
                    compound_enabled=True,
                    odds="100",
                    special_odds="90",
                )
            ]
            self.extra += [
                self.create_play(
                    "0尾单选",
                    kind="tail",
                    scope="all",
                    odds="1.8",
                    zero_tail_odds="2.1234",
                    special_odds="1.7",
                    special_rebate_percent="9.25",
                ),
                self.create_play(
                    "0尾复式",
                    kind="tail",
                    scope="all",
                    quantity=2,
                    combination_size=2,
                    compound_enabled=True,
                    odds="3",
                    zero_tail_odds="3.3333",
                    special_odds="2.5",
                ),
                self.create_play(
                    "0尾不中",
                    kind="tail",
                    scope="all",
                    condition="none",
                    odds="1.8",
                    zero_tail_odds="1.5123",
                ),
            ]
            for kind in ("size", "parity"):
                for scope in ("regular", "special", "all"):
                    self.extra.append(
                        self.create_play(
                            kind + "-" + scope, kind=kind, scope=scope, odds="1.95"
                        )
                    )
            scenarios = [
                [1, 13, 25, 2, 14, 3, 4],
                [6, 45, 1, 13, 2, 3, 4],
                [6, 1, 2, 3, 4, 5, 45],
                [1, 13, 2, 14, 3, 4, 5],
                [1, 13, 25, 37, 49, 2, 14],
                [1, 2, 3, 4, 5, 6, 49],
            ]
            scenarios += [[45, 1, 2, 3, 4, 5, 6], self.random.sample(range(1, 50), 7)]
            dates = [
                (dt.date(2026, 10, 14) + dt.timedelta(days=i)).isoformat()
                for i in range(len(scenarios))
            ] + ["2026-12-31", "2027-01-01"]
            scenarios += [self.random.sample(range(1, 50), 7) for _ in range(2)]
            for day, (date, numbers) in enumerate(zip(dates, scenarios)):
                self.control("time", time=date + "T12:00:00")
                self.year = int(date[:4])
                boot = self.request("GET", "/api/bootstrap")
                self.period = boot["today"]["id"]
                self.models = []
                self.equal(
                    self.period,
                    date[:4] + f"{dt.date.fromisoformat(date).timetuple().tm_yday:03}",
                    "period calendar",
                )
                self.equal(
                    boot["today"]["mapping"]["natal"],
                    (6 + self.year - 2026) % 12,
                    "annual natal",
                )
                self.equal(
                    boot["today"]["mapping"]["zodiac"],
                    [zodiac(n, self.year) for n in range(1, 50)],
                    "annual full mapping",
                )
                for play in list(self.plays.values()) + self.extra:
                    r = play["rule"]
                    pool = (
                        list(range(1, 50))
                        if r["kind"] == "number"
                        else list(
                            range(
                                {
                                    "zodiac": 12,
                                    "tail": 10,
                                    "wave": 3,
                                    "parity": 2,
                                    "size": 2,
                                }.get(r["kind"], 0)
                            )
                        )
                    )
                    for attempt in range(3):
                        opts = (
                            [r["zodiac_count"]]
                            if r["kind"] == "zodiac_count"
                            else self.random.sample(pool, r["quantity"])
                        )
                        if r["name"] == "五有普通多选" or r["name"] == "五有复式":
                            opts = self.random.sample(pool, 7)
                        if (
                            r["name"] in ("二中二", "二中二含特", "特碰", "软碰")
                            and attempt == 0
                        ):
                            opts = [6, 45]
                        if r["name"] == "三中二" and attempt == 0:
                            opts = numbers[:3]
                        self.add(
                            play,
                            opts,
                            r["name"] == "五有复式",
                            amount=self.random.choice(["1", "7", "10", "101"]),
                            bettor=self.random.choice(["客户甲", "客户乙", "客户丙"]),
                        )
                missing = [n for n in range(1, 50) if n not in numbers]
                for opts in [
                    numbers[:2] + [missing[0]],
                    [numbers[0], numbers[6], missing[0]],
                    numbers[:3],
                ]:
                    self.add(
                        self.plays["三中二"], opts, amount="1", bettor="三中二边界客户"
                    )
                # Specific rates must remain frozen through later config edits/deletion.
                if day == 0:
                    historical = self.create_play(
                        "历史含特快照",
                        scope="all",
                        quantity=2,
                        combination_size=2,
                        odds="55",
                        special_hit_odds="25",
                    )
                    self.add(historical, [6, 45])
                    changed = dict(historical["rule"], odds="99", special_hit_odds="88")
                    self.request(
                        "PUT",
                        "/api/plays/" + str(historical["id"]),
                        dict(version=1, rule=changed, enabled=True),
                    )
                    self.request(
                        "POST", "/api/bets", self.payload(historical, [6, 45]), 409
                    )
                    self.request(
                        "DELETE", "/api/plays/" + str(historical["id"]), dict(version=2)
                    )
                    self.request(
                        "POST",
                        "/api/bets",
                        self.payload(dict(historical, version=2), [6, 45]),
                        409,
                    )
                for i, m in enumerate(self.models):
                    if i % 17 == 0:
                        self.revise(m, "111")
                    if i % 13 == 0:
                        self.revise(m, "0.05", receiver="受注方甲")
                        self.revise(m, "0.01", receiver="受注方乙")
                    if i % 29 == 0 and not m["layoffs"]:
                        self.request("POST", "/api/bets/" + m["id"] + "/cancel", {})
                        m["cancelled"] = True
                fly_model = next(m for m in self.models if m["layoffs"])
                fly = fly_model["layoffs"][0]
                self.request("POST", "/api/layoffs/" + fly["id"] + "/cancel", {})
                fly["cancelled"] = True
                self.boundaries(date, day)
                draw, raw = self.raw_draw(date, numbers, override=day == 7)
                self.control("time", time=date + "T21:34:00")
                if day == 0:
                    invalid = dict(raw, openCode="01,01,02,03,04,05,06")
                    self.control("feed", values=[invalid])
                    self.control("tick", force_fetch=True)
                    p = self.request("GET", f"/api/periods/{self.period}")
                    self.equal(p["state"], "pending", "invalid draw preserves bets")
                    self.equal(p["draw"], None, "invalid draw rejected")
                self.control("feed", values=[raw])
                self.control("tick", force_fetch=True)
                self.equal(
                    self.request("GET", f"/api/periods/{self.period}")["state"],
                    "settled",
                    "real worker settled",
                )
                if day == 0:
                    late = self.add(self.plays["特码"], [numbers[6]], amount="10.5")
                    self.equal(self.request("GET", "/api/bets/" + late["id"])["record"]["status"], "settled", "late bet settles atomically")
                    self.revise(late, "12.3")
                    self.revise(late, "0.1", receiver="开奖后受注方")
                    self.verify_settlement(draw)
                    fly = late["layoffs"][0]
                    self.request("POST", "/api/layoffs/" + fly["id"] + "/cancel", {})
                    fly["cancelled"] = True
                    self.request("POST", "/api/bets/" + late["id"] + "/cancel", {})
                    late["cancelled"] = True
                    late["postdraw_cancelled"] = True
                    tomorrow = (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat()
                    self.control("time", time=tomorrow + "T05:59:59")
                    self.equal(self.request("GET", "/api/bootstrap")["today"]["id"], self.period, "pre-06 belongs to previous draw")
                    self.add(self.plays["特码"], [numbers[6]], amount="0.1")
                    quote = self.request("POST", "/api/quote", self.payload(self.plays["特码"], [numbers[6]], amount="0.1"))
                    self.equal(quote["settled"], True, "postdraw quote uses known result")
                    self.control("time", time=tomorrow + "T06:00:00")
                    self.request("POST", "/api/bets", self.payload(self.plays["特码"], [1]), 409)
                    self.equal(self.request("GET", "/api/bootstrap")["today"]["business_date"], tomorrow, "06 starts next draw period")
                    self.control("time", time=date + "T21:34:00")
                    self.cases.append("postdraw entry / correction / outgoing / cancellation and next 06:00 archive")
                if day == 5:
                    size = next(p for p in self.extra if p["rule"]["kind"] == "size" and p["rule"]["scope"] == "special")
                    void_bet = self.add(size, [1], amount="1.5")
                    self.revise(void_bet, "2.7")
                    self.revise(void_bet, "0.1", receiver="和局后受注方")
                    self.cases.append("postdraw 49 refunds recompute principal and suppress rebate")
                stats = self.verify_settlement(draw)
                self.control("replay", draw=raw)
                self.equal(
                    self.request("GET", f"/api/periods/{self.period}/statistics"),
                    stats,
                    "draw retry idempotent",
                )
                conflict = dict(
                    raw, openCode=",".join(f"{n:02}" for n in numbers[1:] + numbers[:1])
                )
                self.control("replay", draw=conflict)
                self.equal(
                    self.request("GET", f"/api/periods/{self.period}/statistics"),
                    stats,
                    "conflicting draw preserves accounting",
                )
                self.draws += 1
                print(
                    f"{self.period}: {len(self.models)} records independently verified",
                    flush=True,
                )
            snapshot = self.request("GET", f"/api/periods/{self.period}/statistics")
            self.stop()
            self.start(False)
            self.equal(
                self.request("GET", f"/api/periods/{self.period}/statistics"),
                snapshot,
                "process restart preserves data and session",
            )
            report = dict(
                seed=SEED,
                customer_plays=len(fixture["plays"]),
                supplementary_plays=len(self.extra),
                recorded_bets=self.bets,
                basic_units=self.units,
                flyouts=self.flyouts,
                settled_periods=self.draws,
                checks=self.checks,
                mismatches=0,
                elapsed_seconds=round(time.monotonic() - started, 2),
                cases=self.cases,
                fixture="localhost HTTP + actual MySQL + actual worker; controlled clock and draw source; licensing covered separately",
            )
            (ROOT / "test-results/runtime-acceptance.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n"
            )
            print(json.dumps(report, ensure_ascii=False, indent=2))
        finally:
            self.stop()
            self.log.close()

    def boundaries(self, date, day):
        strict = self.plays["五有"]
        for options, compound in [
            ([0, 1, 2, 3], False),
            (list(range(7)), False),
        ]:
            self.request(
                "POST", "/api/bets", self.payload(strict, options, compound), 422
            )
        self.request("POST", "/api/bets", self.payload(self.extra[0], [1, 2]), 422)
        base = self.plays["特码"]
        for opts in [[], [1, 1], [0], [50]]:
            self.request("POST", "/api/bets", self.payload(base, opts), 422)
        for amount in ["0", "-1", "1.01", "99999999999999999999999999"]:
            self.request(
                "POST", "/api/bets", self.payload(base, [1], amount=amount), 422
            )
        m = self.models[1]
        self.equal(
            self.request("POST", "/api/bets", m["payload"])["id"],
            m["id"],
            "bet idempotency",
        )
        wrong = dict(m["payload"], amount="222")
        self.request("POST", "/api/bets", wrong, 409)
        if day == 0:
            q = self.request(
                "POST",
                "/api/quote",
                self.payload(self.plays["四肖量"], [4], amount="1"),
            )
            self.equal(q["max_return"], 1500, "exact count quote max")
            self.equal(
                len(set(zodiac(n, self.year) for n in q["result"]["worst_draw"])),
                4,
                "count risk witness",
            )
            pair_quote = self.request(
                "POST",
                "/api/quote",
                self.payload(self.plays["二中二含特"], [6, 45], amount="1"),
            )
            self.equal(pair_quote["max_return"], 5500, "conditional pair quote max")
            self.equal(
                pair_quote["result"]["max_net"],
                90,
                "conditional pair quote best banker net",
            )
            m = next(m for m in self.models if m["rule"]["name"] == "二中二含特")
            self.revise(m, "1.01", expected=422)
            decimal_bet = self.add(base, [9, 21], amount="10.5")
            self.revise(decimal_bet, "12.3")
            self.add(base, [49], amount="0.1")
            self.revise(m, "99999", receiver="受注方甲", expected=409)
            self.control("time", time=date + "T05:59:59")
            self.request("POST", "/api/bets", self.payload(base, [1]), 409)
            self.control("time", time=date + "T06:00:00")
            self.add(base, [49], amount="1")
            self.cases += [
                "Beijing 06:00 inclusive / next 06:00 exclusive",
                "invalid options and amounts",
                "strict vs multi-select vs compound",
                "natal rates per split unit",
                "one-special pair rates",
                "Decimal half-up per original/outgoing unit",
                "invalid / repeated / conflicting draw",
                "annual zodiac rotation",
                "restart persistence",
                "edited / deleted rule snapshot preservation",
                "three-hit-two exact 2 / 3 and special excluded",
                "bettor / receiver / retained aggregation",
            ]
        self.control("time", time=(dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat() + "T06:00:00")
        self.request("POST", "/api/bets", self.payload(base, [1]), 409)
        active = next(m for m in self.models if not m["cancelled"] and not m["layoffs"])
        self.request("POST", "/api/bets/" + active["id"] + "/cancel", {}, 409)
        self.revise(active, "10", expected=409)
        self.revise(active, "0.01", receiver="受注方甲", expected=409)


if __name__ == "__main__":
    Acceptance().execute()
