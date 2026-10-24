import assert from 'node:assert/strict'
import test from 'node:test'
import { RunAwake } from './run-awake.ts'

test('concurrent runs hold one system assertion until the final run settles without holding the display', () => {
  const starts: string[] = [], stops: number[] = []
  const awake = new RunAwake({start:type=>{starts.push(type);return 7},stop:id=>{stops.push(id);return true}})
  const first=awake.acquire('first'), second=awake.acquire('second')
  assert.deepEqual(starts,['prevent-app-suspension'])
  first();first()
  assert.deepEqual(stops,[])
  second()
  assert.deepEqual(stops,[7])
  awake.acquire('third')()
  assert.equal(starts.length,2)
  assert.equal(stops.length,2)
})

test('shutdown releases the assertion and late completion cannot stop a later run', () => {
  const stopped:number[]=[]
  let next=0
  const awake=new RunAwake({start:()=>++next,stop:id=>{stopped.push(id);return true}})
  const old=awake.acquire('old')
  awake.dispose()
  const current=awake.acquire('old')
  old()
  assert.deepEqual(stopped,[1])
  current()
  assert.deepEqual(stopped,[1,2])
})

test('an unavailable native power service cannot break task execution', () => {
  const errors:unknown[]=[]
  const awake=new RunAwake({start:()=>{throw Error('unavailable')},stop:()=>true},error=>errors.push(error))
  awake.acquire('task')()
  awake.dispose()
  assert.equal(errors.length,1)
})
