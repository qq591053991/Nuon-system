import * as bcrypt from 'bcryptjs';
import { config } from '../config';

export const hashPassword = (pw: string) => bcrypt.hashSync(pw, config.bcryptRounds);
export const verifyPassword = (pw: string, hash: string) => {
  try {
    return bcrypt.compareSync(pw, hash);
  } catch {
    return false;
  }
};
