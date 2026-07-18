/**
 * useForm — build a FormSession + handle from loaded data and a transport.
 *
 * Transport-agnostic on purpose: generated controller hooks wire the GET
 * envelope and PATCH mutation in; apps and tests can inject anything.
 *
 *   const loan = useForm({
 *     draft,                          // generated Client instance (or plain object)
 *     mode: 'edit',
 *     envelope,                       // { abilities, can, version } from GET
 *     submit: async (payload) => …,   // PATCH { data, version, _event }
 *   })
 *
 *   <loan.Form>
 *     <loan.amount edit />
 *     <loan.Submit event="submit">Submit application</loan.Submit>
 *   </loan.Form>
 */
import { useRef } from 'react'
import { FormSession, type FormSessionOptions, type ServerEnvelope } from './form-session.js'
import { createFormHandle, type FormHandle } from './form-handle.js'

export interface UseFormOptions<T extends Record<string, any>> extends Omit<FormSessionOptions<T>, 'abilities' | 'can'> {
  /** The GET envelope, when the controller ships abilities. */
  envelope?: ServerEnvelope | null
  /** Per-field meta — defaults to the draft class's generated static fieldMeta. */
  fieldMeta?: Record<string, Record<string, any>>
}

export function useForm<T extends Record<string, any>>(opts: UseFormOptions<T>): FormHandle<T> {
  const ref = useRef<FormHandle<T> | null>(null)
  if (ref.current === null) {
    const { envelope, fieldMeta, ...sessionOpts } = opts
    const session = new FormSession<T>({
      ...sessionOpts,
      abilities: envelope?.abilities ?? null,
      can: envelope?.can ?? null,
    })
    ref.current = createFormHandle(session, fieldMeta ? { fieldMeta } : {})
  }
  return ref.current
}

/** Sugar: an edit-mode form over a loaded envelope. */
export function useEditForm<T extends Record<string, any>>(
  opts: Omit<UseFormOptions<T>, 'mode'>,
): FormHandle<T> {
  return useForm<T>({ ...opts, mode: 'edit' })
}

/** Sugar: a new-record form (no envelope — everything editable until create). */
export function useNewForm<T extends Record<string, any>>(
  opts: Omit<UseFormOptions<T>, 'mode' | 'envelope'>,
): FormHandle<T> {
  return useForm<T>({ ...opts, mode: 'new' })
}
