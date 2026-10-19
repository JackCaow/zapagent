"""Task-independent network preparation and fail-before-model regressions."""
import asyncio
import copy
import json
import shlex
import tempfile
import tomllib
import unittest
from pathlib import Path
from types import SimpleNamespace

from harbor.models.task.config import TaskConfig
from harbor.models.job.config import JobConfig
from harbor.models.trial.config import AgentConfig, EnvironmentConfig
from harbor.trial.network_policy import resolve_agent_env_baseline, resolve_agent_phase_policy, resolve_verifier_phase_policy
from evals.terminal_bench.network_profile import normalize_hosts, prepare_job, verify_prepared
from evals.terminal_bench.test_zap_agent import _agent
from evals.terminal_bench.zap_agent import INDEPENDENT_EVALUATION_INSTRUCTION

class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'original' / 'fixture'
        (self.source / 'environment').mkdir(parents=True)
        (self.source / 'tests').mkdir()
        (self.source / 'task.toml').write_text('version="1.0"\n[agent]\ntimeout_sec=900\n[environment]\ndocker_image="fixture:local"\n[verifier]\ntimeout_sec=700\n')
        (self.source / 'instruction.md').write_text('Solve the supplied synthetic fixture independently.\n')
        (self.source / 'tests/test.sh').write_text('echo synthetic verifier\n')
        self.base = {'job_name':'baseline','n_concurrent_trials':1,'agents':[{'name':'evals.terminal_bench.zap_agent:ZapAgent','model_name':'fixture','kwargs':{'outer_timeout_sec':900}}], 'datasets':[{'name':'fixture','version':'1','task_names':['fixture']}]}
        self.out = self.root / 'prepared'

    def prepare(self):
        return prepare_job(self.base, {'fixture':self.source}, ['docs.example.test','api.example.test'], self.out, 'restricted-fixture')

    def test_preserves_task_bytes_and_budgets_and_scopes_network_to_agent(self):
        before=copy.deepcopy(self.base);report=self.prepare();self.assertEqual(self.base,before)
        self.assertEqual(verify_prepared(self.out),report)
        record=report['taskRecords'][0]
        self.assertEqual({k:v for k,v in record['originalFiles'].items() if k!='task.toml'}, {k:v for k,v in record['preparedFiles'].items() if k!='task.toml'})
        task=TaskConfig.model_validate_toml((self.out/'tasks/fixture/task.toml').read_text())
        baseline=resolve_agent_env_baseline(task,EnvironmentConfig())
        agent=resolve_agent_phase_policy(task,AgentConfig(),baseline)
        verifier=resolve_verifier_phase_policy(task,baseline=baseline)
        self.assertEqual(baseline.network_mode.value,'public')
        self.assertEqual(agent.network_mode.value,'allowlist')
        self.assertEqual(agent.allowed_hosts,sorted(['docs.example.test','api.example.test']))
        self.assertEqual(verifier.network_mode.value,'public')
        self.assertEqual(task.agent.timeout_sec,900);self.assertEqual(task.verifier.timeout_sec,700)
        job=json.loads((self.out/'job.json').read_text());self.assertEqual(job['retry']['max_retries'],0)
        parsed=JobConfig.model_validate(copy.deepcopy(job))
        self.assertEqual(parsed.datasets[0].path,self.out.resolve()/'tasks')
        self.assertEqual(parsed.environment.extra_docker_compose,[self.out.resolve()/'capabilities.json'])
        self.assertEqual(job['agents'][0]['model_name'],'fixture');self.assertEqual(job['agents'][0]['kwargs']['outer_timeout_sec'],900)
        overlay=json.loads((self.out/'capabilities.json').read_text())['services']['main']
        self.assertEqual(overlay['cap_drop'],['NET_ADMIN','NET_RAW']);self.assertIn('no-new-privileges:true',overlay['security_opt'])

    def test_detects_changed_original_or_prepared_contents(self):
        self.prepare();p=self.out/'tasks/fixture/instruction.md';p.write_text('changed')
        with self.assertRaisesRegex(ValueError,'contents changed'):verify_prepared(self.out)

    def test_detects_changed_overlay(self):
        self.prepare();(self.out/'capabilities.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'overlay changed'):verify_prepared(self.out)

    def test_rejects_missing_or_duplicate_records(self):
        self.prepare();p=self.out/'network-profile.json';report=json.loads(p.read_text())
        for records in [[],report['taskRecords']*2]:
            with self.subTest(records=len(records)):
                changed=copy.deepcopy(report);changed['taskRecords']=records;p.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError,'complete selection'):verify_prepared(self.out)

    def test_rejects_unexpected_dataset_entry(self):
        self.prepare();(self.out/'tasks/unrecorded').mkdir()
        with self.assertRaisesRegex(ValueError,'unexpected entries'):verify_prepared(self.out)

    def test_never_overwrites_an_experiment(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError,'already exists'):self.prepare()

    def test_does_not_broaden_existing_task_policy(self):
        with (self.source/'task.toml').open('a') as f:f.write('\nnetwork_mode="no-network"\n')
        # This appends to verifier; explicit verifier policy must remain intact.
        self.prepare();task=tomllib.loads((self.out/'tasks/fixture/task.toml').read_text());self.assertEqual(task['verifier']['network_mode'],'no-network')
        other=self.root/'second';p=self.source/'task.toml';p.write_text(p.read_text().replace('[agent]','[agent]\nnetwork_mode="no-network"'))
        with self.assertRaisesRegex(ValueError,'already has network restrictions'):
            prepare_job(self.base,{'fixture':self.source},['api.example.test'],other,'other')
        self.assertFalse(other.exists())

    def test_rejects_unsafe_layouts_before_creating_output(self):
        for fragment in ['privileged: true','cap_add: [NET_RAW]','network_mode: host','networks: [default]','volumes: [/var/run/docker.sock:/var/run/docker.sock]', 'extends: {file: ../other.yaml, service: main}', 'post_start: [{command: true, privileged: true}]', 'use_api_socket: true', 'pid: service:external', 'devices: [/dev/net/tun]', 'volumes_from: [container:external]']:
            with self.subTest(fragment=fragment):
                (self.source/'environment/docker-compose.yaml').write_text('services:\n  main:\n    '+fragment+'\n')
                with self.assertRaises(ValueError):self.prepare()
                self.assertFalse(self.out.exists())

    def test_rejects_compose_include_and_unsupported_os(self):
        p=self.source/'environment/docker-compose.yaml';p.write_text('include: [../untracked.yaml]\n')
        with self.assertRaisesRegex(ValueError,'includes'):self.prepare()
        p.unlink();p=self.source/'task.toml';p.write_text(p.read_text().replace('[environment]','[environment]\nos="windows"'))
        with self.assertRaisesRegex(ValueError,'Linux'):self.prepare()

    def test_rejects_dataset_filters(self):
        for field,value in [('n_tasks',0),('n_tasks',1),('exclude_task_names',['fixture'])]:
            with self.subTest(field=field,value=value):
                self.base['datasets'][0][field]=value
                with self.assertRaisesRegex(ValueError,'filtering'):self.prepare()
                del self.base['datasets'][0][field]

    def test_rejects_symlinks_selection_drift_and_retries(self):
        (self.source/'alias').symlink_to('instruction.md')
        with self.assertRaisesRegex(ValueError,'symlinks'):self.prepare()
        (self.source/'alias').unlink();self.base['datasets'][0]['task_names']=['different']
        with self.assertRaisesRegex(ValueError,'task set'):self.prepare()
        self.base['datasets'][0]['task_names']=['fixture'];self.base['retry']={'max_retries':1}
        with self.assertRaisesRegex(ValueError,'retries'):self.prepare()

    def test_rejects_overrides_that_can_bypass_profile(self):
        for field,value in [('extra_allowed_hosts',['other.test']),('extra_docker_compose',['override.yml']),('kwargs',{'privileged':True}),('mounts',[{}]),('mounts_json',[{}]),('type','ssh')]:
            with self.subTest(field=field):
                self.base['environment']={field:value}
                with self.assertRaises(ValueError):self.prepare()
                self.assertFalse(self.out.exists())

    def test_exact_host_normalization(self):
        self.assertEqual(normalize_hosts(['DOCS.example.test.','docs.example.test']),['docs.example.test'])
        for invalid in [[],['*'],['*.example.test'],['https://example.test'],['example.test:443'],['127.0.0.1'],['a.local'],[' example.test'],['example.test\nother.test']]:
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):normalize_hosts(invalid)

class BoundaryTests(unittest.TestCase):
    def env(self,hosts=None,mode='allowlist',caps='0000000000000000',nnp='1',supported=True):
        class Environment:
            calls=[]
            network_policy=SimpleNamespace(network_mode=SimpleNamespace(value=mode),allowed_hosts=hosts or ['api.example.test'])
            capabilities=SimpleNamespace(network_allowlist_hostnames=supported,dynamic_network_policy=supported)
            async def exec(self,**kwargs):
                self.calls.append(kwargs)
                return SimpleNamespace(return_code=0,stdout=f'CapEff:\t{caps}\nCapBnd:\t{caps}\nNoNewPrivs:\t{nnp}\n')
        return Environment()

    def test_records_effective_boundary_outside_prompt(self):
        agent=_agent();agent.network_allowlist=['api.example.test'];env=self.env();ctx=SimpleNamespace(metadata=None)
        asyncio.run(agent._verify_network_boundary(env,ctx))
        self.assertEqual(ctx.metadata['networkBoundary']['allowedHosts'],['api.example.test'])
        self.assertEqual(env.calls,[{'command':'cat /proc/self/status','user':'root'}])

    def test_effective_policy_is_described_and_survives_final_result(self):
        agent=_agent();agent.network_allowlist=['api.example.test'];env=self.env()
        original_exec=env.exec
        async def execute(**kwargs):
            if kwargs['command']=='cat /proc/self/status':return await original_exec(**kwargs)
            env.calls.append(kwargs)
            final={'type':'result','ok':True,'text':'done','sessionId':'fixture','turns':1,
                   'usage':{'inputTokens':0,'outputTokens':0},'toolCalls':[],'stopReason':'end_turn'}
            return SimpleNamespace(return_code=0,stdout=json.dumps(final),stderr='')
        env.exec=execute;ctx=SimpleNamespace(metadata=None)
        asyncio.run(agent.run('synthetic instruction',env,ctx))
        self.assertEqual(len(env.calls),2)
        args=shlex.split(env.calls[1]['command'])
        prompt=args[args.index('--system-prompt-append')+1]
        self.assertTrue(prompt.startswith(INDEPENDENT_EVALUATION_INSTRUCTION))
        self.assertIn('api.example.test',prompt)
        self.assertEqual(args[args.index('--print')+1],'synthetic instruction')
        self.assertEqual(ctx.metadata['networkBoundary']['allowedHosts'],['api.example.test'])

    def test_rejects_missing_policy_before_any_model_or_guest_call(self):
        for kwargs in [{'mode':'public'},{'hosts':['other.test']},{'supported':False}]:
            agent=_agent();agent.network_allowlist=['api.example.test'];env=self.env(**kwargs)
            with self.assertRaisesRegex(RuntimeError,'not enforced'):
                asyncio.run(agent.run('fixture',env,SimpleNamespace(metadata=None)))
            self.assertEqual(env.calls,[])

    def test_rejects_capability_regain_and_mark_bypass(self):
        for kwargs in [{'caps':'0000000000001000'},{'caps':'0000000000002000'},{'nnp':'0'}]:
            agent=_agent();agent.network_allowlist=['api.example.test'];env=self.env(**kwargs)
            with self.assertRaisesRegex(RuntimeError,'bypass network'):
                asyncio.run(agent.run('fixture',env,SimpleNamespace(metadata=None)))
            self.assertEqual(len(env.calls),1)

if __name__=='__main__':unittest.main()
