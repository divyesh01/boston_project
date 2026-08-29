#!/usr/bin/env python3
"""Deterministic identity tests for the existing Claude checkpoint wrapper."""

import io
import json
import urllib.error

from scripts import claude_provider
from scripts import openrouter_support


assert openrouter_support._affordable_token_limit(
    'requested 1000 tokens, but can only afford 432', 1000
) == 432
assert openrouter_support._affordable_token_limit('unrelated error', 300) is None


class _FakeResponse:
    def __init__(self, body):
        self._body = json.dumps(body).encode('utf-8')

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._body


original_urlopen = openrouter_support.urllib.request.urlopen
budgets = []


def _fake_urlopen(request, timeout):
    del timeout
    budgets.append(json.loads(request.data.decode('utf-8'))['max_tokens'])
    if len(budgets) == 1:
        body = b'{"error":{"message":"requested 1000 tokens, but can only afford 432"}}'
        raise urllib.error.HTTPError(
            request.full_url, 402, 'Payment Required', {}, io.BytesIO(body)
        )
    return _FakeResponse({
        'id': 'gen-resized',
        'model': 'anthropic/claude-sonnet-5',
        'provider': 'Claude Platform on AWS',
        'choices': [{'message': {'content': 'RESIZED_OK'}}],
    })


try:
    openrouter_support.urllib.request.urlopen = _fake_urlopen
    resized = openrouter_support.call_openrouter_model_detailed(
        model='anthropic/claude-sonnet-5',
        messages=[{'role': 'user', 'content': 'test'}],
        api_key='test-key',
        max_tokens=1000,
    )
    assert resized['success'] is True
    assert budgets == [1000, 432]
    assert resized['token_budget_used'] == 432
finally:
    openrouter_support.urllib.request.urlopen = original_urlopen

original_key = claude_provider.ops.get_stored_key
original_call = claude_provider.ops.call_openrouter_model_detailed

try:
    claude_provider.ops.get_stored_key = lambda: 'test-key'

    claude_provider.ops.call_openrouter_model_detailed = lambda **_kwargs: {
        'success': True,
        'content': 'generic fallback',
        'error': None,
        'transport_provider': 'OPENROUTER',
        'actual_provider': 'MINIMAX',
        'actual_model': 'minimax/minimax-m3:free',
        'upstream_provider': 'GMICloud',
    }
    rejected = claude_provider.call_claude_checkpoint(
        'CP1', 'identity test', preferred_model='anthropic/claude-sonnet-5'
    )
    assert rejected['success'] is False
    assert rejected['model_used'] is None

    claude_provider.ops.call_openrouter_model_detailed = lambda **_kwargs: {
        'success': True,
        'content': 'CLAUDE_OK',
        'error': None,
        'transport_provider': 'OPENROUTER',
        'actual_provider': 'ANTHROPIC',
        'actual_model': 'anthropic/claude-sonnet-5',
        'upstream_provider': 'Claude Platform on AWS',
        'generation_id': 'gen-test',
        'token_budget_used': 200,
    }
    accepted = claude_provider.call_claude_checkpoint(
        'CP1', 'identity test', preferred_model='anthropic/claude-sonnet-5'
    )
    assert accepted['success'] is True
    assert accepted['transport_provider'] == 'OPENROUTER'
    assert accepted['actual_provider'] == 'ANTHROPIC'
    assert accepted['model_used'] == 'anthropic/claude-sonnet-5'
finally:
    claude_provider.ops.get_stored_key = original_key
    claude_provider.ops.call_openrouter_model_detailed = original_call

print('CLAUDE PROVIDER TRUTH PROBE PASSED (12 assertions)')
